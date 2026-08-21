const { spawn } = require("child_process");

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 500;

function createManagedProcessError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function signalProcessTree(child, signal) {
  if (!child || !child.pid) {
    return false;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        try {
          child.kill(signal);
          return true;
        } catch (_) {
          return false;
        }
      }
      return false;
    }
  }

  try {
    return child.kill(signal);
  } catch (_) {
    return false;
  }
}

function runManagedProcess(command, args = [], options = {}) {
  const {
    cwd,
    env,
    signal,
    timeoutMs = 0,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    spawnImpl = spawn,
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationReason = null;
    let timeoutId = null;
    let forceKillId = null;

    const clearLifecycleHandlers = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (forceKillId) {
        clearTimeout(forceKillId);
        forceKillId = null;
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
    };

    const terminate = (reason) => {
      if (terminationReason || !child) {
        return;
      }
      terminationReason = reason;
      signalProcessTree(child, "SIGTERM");
      forceKillId = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
      }, Math.max(0, killGraceMs));
    };

    const handleAbort = () => terminate("aborted");

    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const appendOutput = (streamName, chunk) => {
      const text = chunk.toString();
      const bytes = Buffer.byteLength(text);
      if (streamName === "stdout") {
        stdoutBytes += bytes;
        stdout += text;
      } else {
        stderrBytes += bytes;
        stderr += text;
      }

      if (
        stdoutBytes > maxBufferBytes ||
        stderrBytes > maxBufferBytes
      ) {
        terminate("maxBuffer");
      }
    };

    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearLifecycleHandlers();
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearLifecycleHandlers();

      if (terminationReason) {
        const timedOut = terminationReason === "timeout";
        const aborted = terminationReason === "aborted";
        const maxBufferExceeded = terminationReason === "maxBuffer";
        const message = timedOut
          ? `Command timed out after ${timeoutMs}ms: ${command}`
          : aborted
            ? `Command aborted: ${command}`
            : `Command output exceeded ${maxBufferBytes} bytes: ${command}`;
        reject(
          createManagedProcessError(message, {
            name: aborted ? "AbortError" : "Error",
            code: maxBufferExceeded ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code,
            signal: closeSignal,
            killed: true,
            timedOut,
            aborted,
            stdout,
            stderr,
          }),
        );
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr, code, signal: closeSignal });
        return;
      }

      reject(
        createManagedProcessError(
          `Command failed with exit code ${code}: ${command}`,
          {
            code,
            signal: closeSignal,
            killed: false,
            timedOut: false,
            aborted: false,
            stdout,
            stderr,
          },
        ),
      );
    });

    if (signal) {
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
      }
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimeout(() => terminate("timeout"), timeoutMs);
    }
  });
}

module.exports = {
  createManagedProcessError,
  runManagedProcess,
  signalProcessTree,
};
