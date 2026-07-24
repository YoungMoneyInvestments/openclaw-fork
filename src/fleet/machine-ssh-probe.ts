import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import type {
  FleetMachineEndpointProbe,
  FleetMachineEndpointProbeErrorCode,
} from "./machine-inventory.js";

type RunCommand = typeof runCommandWithTimeout;

const SSH_OUTPUT_LIMIT_BYTES = 64 * 1024;

function failureCode(result: Awaited<ReturnType<RunCommand>>): FleetMachineEndpointProbeErrorCode {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    detail.includes("host key verification failed") ||
    detail.includes("remote host identification has changed")
  ) {
    return "host_key_failed";
  }
  if (
    detail.includes("permission denied") ||
    detail.includes("no supported authentication methods available")
  ) {
    return "auth_failed";
  }
  if (
    result.termination === "timeout" ||
    detail.includes("operation timed out") ||
    detail.includes("connection timed out") ||
    detail.includes("network is unreachable") ||
    detail.includes("no route to host") ||
    detail.includes("could not resolve hostname")
  ) {
    return "transport_unreachable";
  }
  return "service_failed";
}

export function createFleetMachineSshProbe(
  options: {
    runCommand?: RunCommand;
    knownHostsPath?: string;
    sshPath?: string;
    timeoutMs?: number;
  } = {},
): FleetMachineEndpointProbe {
  const runCommand = options.runCommand ?? runCommandWithTimeout;
  const knownHostsPath = options.knownHostsPath ?? path.join(os.homedir(), ".ssh", "known_hosts");
  const sshPath = options.sshPath ?? "/usr/bin/ssh";
  const timeoutMs = options.timeoutMs ?? 5_000;

  return async (request) => {
    const result = await runCommand(
      [
        sshPath,
        "-F",
        "none",
        "-o",
        "BatchMode=yes",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        `HostKeyAlias=${request.ssh.hostKeyAlias}`,
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "-o",
        "GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-p",
        String(request.endpoint.port),
        "--",
        `${request.ssh.user}@${request.endpoint.host}`,
        "true",
      ],
      {
        timeoutMs,
        maxOutputBytes: SSH_OUTPUT_LIMIT_BYTES,
        outputCapture: "tail",
        terminateOnOutputLimit: true,
        killProcessTree: true,
      },
    );
    if (result.code === 0 && result.termination === "exit") {
      return { status: "reachable" };
    }
    return { status: "failed", code: failureCode(result) };
  };
}
