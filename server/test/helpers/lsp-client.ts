// Minimal LSP client over a child process's stdio, for integration tests.
//
// Speaks just enough JSON-RPC/LSP to drive the sidecar: requests, notifications
// (collected), and server-initiated requests (answered by `onRequest`).

import { spawn, type ChildProcess } from "node:child_process";

export interface RecordedMessage {
  method: string;
  params: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Waiter {
  method: string;
  predicate: (params: any) => boolean;
  resolve: (params: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LspClient {
  /** Every server-initiated notification, in arrival order. */
  readonly notifications: RecordedMessage[] = [];
  /** Every server-initiated request (workspace/configuration, showMessageRequest, ...). */
  readonly serverRequests: RecordedMessage[] = [];
  /** stderr from the server, for failure diagnostics. */
  readonly stderr: string[] = [];

  /** Answer a server-initiated request; return its result, throw to error. */
  onRequest: (method: string, params: unknown) => unknown = () => null;

  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters: Waiter[] = [];

  constructor(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString()));
    this.child.on("exit", (code) => {
      const error = new Error(
        `language server exited with code ${code}\n${this.stderr.join("")}`,
      );
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}\n${this.stderr.join("")}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  notificationsFor(method: string): unknown[] {
    return this.notifications.filter((n) => n.method === method).map((n) => n.params);
  }

  serverRequestsFor(method: string): unknown[] {
    return this.serverRequests.filter((r) => r.method === method).map((r) => r.params);
  }

  /** Resolve with the first notification of `method` (existing or future) that matches. */
  waitForNotification(
    method: string,
    predicate: (params: any) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<any> {
    const existing = this.notifications.find(
      (n) => n.method === method && predicate(n.params),
    );
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${method}\n${this.stderr.join("")}`));
      }, timeoutMs);
      this.waiters.push({
        method,
        predicate,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
        reject,
        timer,
      });
    });
  }

  /** Wait until a server-initiated request of `method` has been seen. */
  waitForServerRequest(method: string, timeoutMs = 15_000): Promise<any> {
    const existing = this.serverRequests.find((r) => r.method === method);
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const found = this.serverRequests.find((r) => r.method === method);
        if (found) {
          clearInterval(timer);
          clearTimeout(guard);
          resolve(found.params);
        }
      }, 10);
      const guard = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`timed out waiting for server request ${method}\n${this.stderr.join("")}`));
      }, timeoutMs);
    });
  }

  async dispose(): Promise<void> {
    try {
      await this.request("shutdown", undefined, 3_000);
      this.notify("exit");
    } catch {
      /* force-kill below */
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private send(message: unknown): void {
    const json = JSON.stringify(message);
    this.child.stdin?.write(
      `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
    );
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(JSON.parse(body));
    }
  }

  private dispatch(message: any): void {
    if (message.id !== undefined && message.method !== undefined) {
      this.serverRequests.push({ method: message.method, params: message.params });
      let result: unknown = null;
      let error: { code: number; message: string } | undefined;
      try {
        result = this.onRequest(message.method, message.params);
      } catch (thrown) {
        error = {
          code: -32603,
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
      }
      if (result instanceof Promise) {
        result.then(
          (value) => this.send(error ? { jsonrpc: "2.0", id: message.id, error } : { jsonrpc: "2.0", id: message.id, result: value ?? null }),
          (thrown) =>
            this.send({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32603,
                message: thrown instanceof Error ? thrown.message : String(thrown),
              },
            }),
        );
        return;
      }
      this.send(
        error
          ? { jsonrpc: "2.0", id: message.id, error }
          : { jsonrpc: "2.0", id: message.id, result: result ?? null },
      );
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      this.notifications.push({ method: message.method, params: message.params });
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i]!;
        if (waiter.method !== message.method) continue;
        if (!waiter.predicate(message.params)) continue;
        this.waiters.splice(i, 1);
        waiter.resolve(message.params);
      }
    }
  }
}
