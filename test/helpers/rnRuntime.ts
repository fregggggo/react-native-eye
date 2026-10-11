import vm from "node:vm";

/**
 * A stand-in for the app's JS runtime: a real VM context (so `eval`, `globalThis`
 * and closures behave as they do in Hermes) whose `Promise` is a *polyfill*, like
 * React Native's. That is what makes CDP's awaitPromise useless — the inspector
 * sees a plain object — so every test of the evaluate protocol runs against it.
 */
const POLYFILL_PROMISE = `
  (function () {
    function P(executor) {
      this._h = 0; this._i = 0; this._j = null; this._k = null;
      var self = this;
      if (executor) executor(function (v) { self.__settle(1, v); }, function (e) { self.__settle(2, e); });
    }
    P.prototype.__settle = function (state, value) {
      if (this._i !== 0) return;
      this._i = state; this._j = value;
      var cbs = this._k || []; this._k = null;
      for (var i = 0; i < cbs.length; i++) this.__fire(cbs[i]);
    };
    P.prototype.__fire = function (cb) {
      var self = this;
      setTimeout(function () { (self._i === 1 ? cb.onF : cb.onR)(self._j); }, 0);
    };
    P.prototype.then = function (onF, onR) {
      var self = this;
      return new P(function (res, rej) {
        var cb = {
          onF: function (v) { try { res(onF ? onF(v) : v); } catch (e) { rej(e); } },
          onR: function (e) { if (onR) { try { res(onR(e)); } catch (e2) { rej(e2); } } else rej(e); }
        };
        if (self._i === 0) { self._k = self._k || []; self._k.push(cb); } else self.__fire(cb);
      });
    };
    P.prototype.catch = function (onR) { return this.then(null, onR); };
    P.resolve = function (v) { return new P(function (r) { r(v); }); };
    P.reject = function (e) { return new P(function (_, r) { r(e); }); };
    P.all = function (list) {
      return new P(function (res, rej) {
        var out = new Array(list.length); var left = list.length;
        if (!left) return res(out);
        list.forEach(function (p, i) {
          P.resolve(p).then(function (v) { out[i] = v; if (--left === 0) res(out); }, rej);
        });
      });
    };
    globalThis.Promise = P;
  })();
`;

export type FakeRuntime = {
  sandbox: any;
  evaluate(expression: string): unknown;
};

export function makeRuntime(globals: Record<string, unknown> = {}): FakeRuntime {
  const sandbox: any = { setTimeout, clearTimeout, console, ...globals };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(POLYFILL_PROMISE, sandbox);
  return {
    sandbox,
    evaluate: (expression: string) => vm.runInContext(expression, sandbox),
  };
}

/** A CdpClient-shaped fake that runs Runtime.evaluate inside `runtime`. */
export function fakeClient(runtime: FakeRuntime, opts?: { onSend?: (method: string) => void }) {
  return {
    connected: true,
    on() {},
    onClose() {},
    close() {},
    async send(method: string, params: any) {
      opts?.onSend?.(method);
      if (method !== "Runtime.evaluate") return {};
      try {
        return { result: { value: runtime.evaluate(params.expression) } };
      } catch (e) {
        return { exceptionDetails: { text: String(e) } };
      }
    },
  };
}
