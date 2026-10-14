// The OCR helper is a tiny Swift program around Apple's Vision framework. It is
// kept as source (String.raw so Swift escapes survive) and compiled once on the
// host by src/ocr/vision.ts — no binary in the package, no npm dependency.
//
// Contract: `rne-ocr <png-path> [--languages a,b]` prints one JSON object
// {"width":W,"height":H,"lines":[{"text","x","y","w","h","confidence"}]} with
// boxes in image pixels, top-left origin. Failures: message on stderr, exit 2.
//
// Keep this string free of backticks, "${" and any http(s) URL: the first two
// would break the literal, the last fails the privacy test.
export const VISION_OCR_SOURCE = String.raw`import Foundation
import CoreGraphics
import ImageIO
import Vision

// rne-ocr <png-path> [--languages a,b]
// Prints {"width":W,"height":H,"lines":[{"text","x","y","w","h","confidence"}]}
// Boxes in image pixels, top-left origin. Errors: stderr + exit 2.

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

let args = Array(CommandLine.arguments.dropFirst())
var languages: [String] = []
var imagePath: String? = nil
var i = 0
while i < args.count {
    let a = args[i]
    if a == "--languages" && i + 1 < args.count {
        languages = args[i + 1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        i += 2
    } else if imagePath == nil {
        imagePath = a
        i += 1
    } else {
        fail("unexpected argument: \(a)")
    }
}
guard let path = imagePath else { fail("usage: rne-ocr <png-path> [--languages a,b]") }

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("could not decode image at \(path)")
}
let width = Double(image.width)
let height = Double(image.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if languages.isEmpty {
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
} else {
    // Accept "de" as well as "de-DE": resolve each request against what Vision supports.
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    var resolved: [String] = []
    for want in languages {
        let w = want.lowercased()
        if let hit = supported.first(where: { $0.lowercased() == w })
            ?? supported.first(where: { $0.lowercased().hasPrefix(w + "-") }) {
            resolved.append(hit)
        } else {
            fail("unsupported language \"\(want)\"; supported: \(supported.joined(separator: ", "))")
        }
    }
    request.recognitionLanguages = resolved
}

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("text recognition failed: \(error.localizedDescription)")
}

var lines: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox   // normalized, origin bottom-left
    lines.append([
        "text": candidate.string,
        "x": box.minX * width,
        "y": (1 - box.maxY) * height,
        "w": box.width * width,
        "h": box.height * height,
        "confidence": Double(candidate.confidence),
    ])
}
let payload: [String: Any] = ["width": Int(width), "height": Int(height), "lines": lines]
guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
    fail("could not encode result")
}
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
`;
