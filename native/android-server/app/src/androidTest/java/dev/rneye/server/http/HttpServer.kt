package dev.rneye.server.http

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.util.Log
import org.json.JSONException
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

private const val TAG = "RNEye"
private const val MAX_BODY = 1 shl 20
private const val MAX_LINE = 8192
private const val MAX_HEADERS = 100
/** observe runs a screenshot and a hierarchy at once, plus /status probes; everything else is serial. */
private const val MAX_WORKERS = 8
private const val READ_TIMEOUT_MS = 10_000

/**
 * The only peers allowed to connect: root (adbd on a rooted or `adb root` device) and
 * shell (adbd everywhere else). An `adb forward … localabstract:<name>` connection comes
 * from adbd; every other app on the device has its own uid and is refused.
 */
private val ALLOWED_UIDS = setOf(0, 2000)

/** `127.0.0.1`, `localhost` or `[::1]`, with an optional port: what a client of the adb forward sends. */
private val LOCAL_HOST_RE = Regex("""^(127\.0\.0\.1|localhost|\[::1])(:\d{1,5})?$""", RegexOption.IGNORE_CASE)

class HttpError(val status: Int, val code: String, message: String) : Exception(message)

class Request(val method: String, val path: String, val contentType: String?, val host: String?, val body: ByteArray) {
    fun json(): JSONObject = if (body.isEmpty()) JSONObject() else try {
        JSONObject(String(body, Charsets.UTF_8))
    } catch (e: JSONException) {
        throw HttpError(400, "bad_request", "body is not a JSON object: ${e.message}")
    }
}

class Response(val status: Int, val contentType: String, val body: ByteArray) {
    companion object {
        fun json(o: JSONObject, status: Int = 200) = Response(status, "application/json", o.toString().toByteArray(Charsets.UTF_8))
        fun png(bytes: ByteArray) = Response(200, "image/png", bytes)
        fun empty(status: Int) = Response(status, "text/plain", ByteArray(0))
        fun error(status: Int, code: String, message: String) =
            json(JSONObject().put("code", code).put("errorMessage", message), status)
    }
}

typealias Handler = (Request) -> Response

/**
 * Minimal HTTP/1.1 over a Unix-domain socket in the abstract namespace (`socketName`,
 * random per start, chosen by the host): the host reaches it only through
 * `adb forward tcp:0 localabstract:<socketName>`. No TCP port is opened on the device,
 * and each accepted connection must come from adbd's uid (ALLOWED_UIDS), so other apps
 * on the device can neither drive UiAutomation through us nor squat our endpoint.
 *
 * One request per connection, Content-Length bodies only, `Connection: close`. The Host
 * header must name the loopback (DNS-rebinding guard for the host-side forward port).
 * Any method is accepted on every route. A POST whose body is not application/json gets
 * 415 (same contract as the iOS runner).
 */
class HttpServer(private val socketName: String, private val routes: Map<String, Handler>) {
    /** Bounded: a flood of connections gets 503 busy instead of exhausting threads. */
    private val workers = ThreadPoolExecutor(0, MAX_WORKERS, 30L, TimeUnit.SECONDS, SynchronousQueue(), ThreadPoolExecutor.AbortPolicy())

    fun serveForever() {
        // LocalServerSocket(String) binds in the Linux abstract namespace; it fails if the name is taken.
        val server = LocalServerSocket(socketName)
        Log.i(TAG, "listening on localabstract:$socketName")
        while (true) {
            val socket = server.accept()
            val uid = try { socket.peerCredentials.uid } catch (t: IOException) { -1 }
            if (uid !in ALLOWED_UIDS) {
                Log.w(TAG, "refused a connection from uid $uid (only adbd may connect)")
                closeQuietly(socket)
                continue
            }
            try {
                workers.execute { handle(socket) }
            } catch (e: RejectedExecutionException) {
                try { write(socket.outputStream, Response.error(503, "busy", "all $MAX_WORKERS workers are busy")) } catch (_: Throwable) {}
                closeQuietly(socket)
            }
        }
    }

    private fun closeQuietly(s: LocalSocket) = try { s.close() } catch (_: Throwable) {}

    private fun handle(socket: LocalSocket) = socket.use { s ->
        s.soTimeout = READ_TIMEOUT_MS
        val response = try {
            val req = readRequest(BufferedInputStream(s.inputStream)) ?: return@use
            route(req)
        } catch (e: HttpError) {
            Response.error(e.status, e.code, e.message ?: e.code)
        } catch (t: Throwable) {
            Log.e(TAG, "request failed", t)
            Response.error(500, "internal", t.toString())
        }
        try { write(s.outputStream, response) } catch (t: Throwable) { Log.w(TAG, "write failed", t) }
    }

    private fun route(req: Request): Response {
        val host = req.host
        if (host == null || !LOCAL_HOST_RE.matches(host)) {
            return Response.error(403, "bad_host", "Host must be 127.0.0.1 or localhost (got ${host ?: "none"})")
        }
        val handler = routes[req.path] ?: return Response.empty(404)
        if (req.method == "POST") {
            val type = req.contentType?.substringBefore(';')?.trim()?.lowercase()
            if (type != "application/json") {
                return Response.error(415, "unsupported_media_type", "POST bodies must be application/json")
            }
        }
        return handler(req)
    }

    private fun readRequest(input: InputStream): Request? {
        val requestLine = readLine(input) ?: return null
        val parts = requestLine.split(' ')
        if (parts.size < 2) throw HttpError(400, "bad_request", "bad request line")
        var length = 0
        var contentType: String? = null
        var host: String? = null
        var headers = 0
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            if (++headers > MAX_HEADERS) throw HttpError(431, "headers_too_large", "more than $MAX_HEADERS header lines")
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            when (name) {
                "content-length" -> length = value.toIntOrNull()?.takeIf { it >= 0 }
                    ?: throw HttpError(400, "bad_request", "bad Content-Length")
                "content-type" -> contentType = value
                "host" -> host = value
                "transfer-encoding" -> throw HttpError(411, "length_required", "chunked bodies are not supported")
            }
        }
        if (length > MAX_BODY) throw HttpError(413, "too_large", "body over $MAX_BODY bytes")
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) throw HttpError(400, "bad_request", "body shorter than Content-Length")
            read += n
        }
        return Request(parts[0].uppercase(), parts[1].substringBefore('?'), contentType, host, body)
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            if (b == '\n'.code) return buf.toString("ISO-8859-1").trimEnd('\r')
            buf.write(b)
            if (buf.size() > MAX_LINE) throw HttpError(431, "headers_too_large", "header line too long")
        }
    }

    private fun write(out: OutputStream, r: Response) {
        val head = "HTTP/1.1 ${r.status} ${reason(r.status)}\r\n" +
            "Content-Type: ${r.contentType}\r\nContent-Length: ${r.body.size}\r\nConnection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.ISO_8859_1))
        out.write(r.body)
        out.flush()
    }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"; 400 -> "Bad Request"; 403 -> "Forbidden"; 404 -> "Not Found"; 411 -> "Length Required"
        413 -> "Payload Too Large"; 415 -> "Unsupported Media Type"; 431 -> "Request Header Fields Too Large"
        500 -> "Internal Server Error"; 501 -> "Not Implemented"; 503 -> "Service Unavailable"; else -> "Status"
    }
}
