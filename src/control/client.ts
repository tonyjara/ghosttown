import type { Request, Response } from "./protocol";

let nextRequestId = 1;

/** One-shot request over the control socket. */
export async function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 3000,
): Promise<unknown> {
  const req: Request = { id: nextRequestId++, method, params };
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("timed out waiting for ghosttown"));
      }
    }, timeoutMs);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(req) + "\n");
        },
        data(socket, data) {
          buffer += data.toString();
          const nl = buffer.indexOf("\n");
          if (nl === -1) return;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            try {
              const res = JSON.parse(buffer.slice(0, nl)) as Response;
              if (res.ok) resolve(res.result);
              else reject(new Error(res.error));
            } catch (err) {
              reject(err);
            }
          }
          // end() last — it can abort the rest of the handler in Bun.
          try {
            socket.end();
          } catch {
            // already closed
          }
        },
        error(_socket, error) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
        close() {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new Error("connection closed"));
          }
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
