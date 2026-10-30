const limit = 65536;
function failure(status) {
  return Object.assign(
    new Error("Invalid or unsupported OAuth form callback."),
    { status },
  );
}

// Read a bounded copy only to choose the route. A 307 asks the browser to resend
// its original bytes; Benzo never rebuilds the form or changes cookie policy.
export function readCallbackState(request) {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      request.headers["content-type"] ?? "",
    ) ||
    (request.headers["content-encoding"] &&
      !/^identity$/i.test(request.headers["content-encoding"]))
  )
    return Promise.reject(failure(415));
  if (Number(request.headers["content-length"]) > limit)
    return Promise.reject(failure(413));
  return new Promise((resolve, reject) => {
    let done = false,
      size = 0;
    const chunks = [];
    const finish = (error, state) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      chunks.length = 0;
      if (error) reject(error);
      else resolve(state);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) return finish(failure(413));
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(Buffer.concat(chunks));
        // URLSearchParams tolerates malformed percent escapes; reject those
        // rather than choosing a state different from a strict app parser.
        for (const pair of text.split("&"))
          for (const part of pair.split("="))
            decodeURIComponent(part.replace(/\+/g, " "));
        const states = new URLSearchParams(text).getAll("state");
        if (states.length !== 1 || !states[0] || states[0].length > 8192)
          throw failure(400);
        finish(undefined, states[0]);
      } catch {
        finish(failure(400));
      }
    };
    const timer = setTimeout(() => finish(failure(408)), 5000);
    timer.unref();
    request.on("data", data);
    request.once("end", end);
    request.once("aborted", () => finish(failure(400)));
    request.once("error", () => finish(failure(400)));
  });
}
