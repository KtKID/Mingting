# Mingting

[简体中文](README.md)

A shared workspace for humans and agents.

MVP 0.2 is a local task platform. MCP exposes one publishing tool. A separate Codex connector receives durable task events over HTTP SSE, claims queued work and executes it through Codex ACP. The React/TypeScript interface shows task details and lets a person handle permission requests.

## Features and scope

| Capability                 | Current implementation                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task publishing            | The only MCP tool is `publish_task`, with `title`, `description` and `publisherName`. The web form uses the same task service.                       |
| Task list                  | A React/TypeScript list shows title, description, publisher, status, result and approvals. It supports desktop/mobile layouts and light/dark themes. |
| Subscription and ownership | Independent HTTP SSE subscriptions, persisted SQLite events, replay after disconnect, atomic claims and run ownership.                               |
| Execution                  | One local Codex connector uses the open-source Codex ACP adapter to communicate with Codex App Server.                                               |
| Human approvals            | Original tool context and permission options; allow/reject, cancellation, timeouts and stale-request rejection. No automatic approval.               |
| Recovery and reporting     | Heartbeat leases, ordered/idempotent status reports, process-failure recovery and explicit retry. Event receipt is not execution success.            |
| Persistence                | SQLite stores tasks, runs, approvals and bounded ACP session history. Task-availability events support replay.                                       |

This MVP targets one trusted local user, one platform instance and one Codex executor. It does not include multiple Harnesses, remote workers, multi-user authentication/authorization, task DAGs, a chat workspace, model routing, automatic Git merges or a public backend. The web interface is currently Chinese; the language switch above applies to the documentation.

The existing private Site is a browser-local UI demonstration. It does not run this Node backend and its URL is not an MCP endpoint.

Task subscriptions use Mingting's application HTTP protocol. Codex execution uses standard ACP v1. Browser polling refreshes the interface; it is separate from the connector's real task-event subscription.

## Requirements and a safe demo

Use Node 24+ and run these commands from the repository root:

```bash
npm ci --ignore-scripts
npm run build
FAKE_ACP=1 npm start
```

Open **http://127.0.0.1:60390**. The service automatically starts a separate Node subscription connector process. Publish a task; the connector logs the received event ID. Open task details to allow, reject or cancel the requested operation.

`FAKE_ACP=1` uses the real ACP-speaking test process in `tests/fake-acp.ts`. HTTP, SSE, SQLite, claiming, heartbeat, permission forwarding and reporting use the actual implementation. The model and tool operation are simulated: the demo does not call a model or execute the displayed command. The UI marks this mode explicitly.

## Run the service and connector separately

Terminal 1, platform only:

```bash
FAKE_ACP=1 TASK_CONNECTOR=manual npm start
```

Tasks can be published while the connector is offline; they remain `queued`. There is no competing hidden execution queue in the server.

Terminal 2, start the Codex connector:

```bash
FAKE_ACP=1 npm run connector
```

A new connector reads historical and live events from cursor 0 and claims work that is still queued. A connector failure does not mark a task successful. Claimed runs become interrupted after their lease expires and require explicit retry.

## Connect real Codex ACP

The lockfile includes `@agentclientprotocol/codex-acp` 2.5.0 and its compatible Codex CLI dependency. Mingting starts its Node entrypoint; the adapter starts Codex App Server. It does not parse `codex exec` text as ACP, and does not require Codeg or the Zed application.

First authenticate on your own machine:

```bash
npx --no-install codex-acp login
```

Then explicitly select an existing test project directory:

```bash
TASK_WORKSPACE=/absolute/path/to/your/project npm start
```

This starts the platform and a real Codex subscription connector. The default `TASK_AUTH=existing` uses your existing Codex login. Set `CODEX_HOME` if you use a separate Codex configuration directory. Mingting does not scan or copy credentials and does not provide a login page.

For explicit API-key authentication, first provide `CODEX_API_KEY` or `OPENAI_API_KEY` in your process environment, then run:

```bash
TASK_AUTH=api-key TASK_WORKSPACE=/absolute/path/to/your/project npm start
```

The connector checks the adapter's advertised authentication methods before calling ACP `authenticate`. Model keys are not stored in the task database or sent to the web interface. The adapter's own login can update your chosen Codex configuration directory. Missing authentication fails the run; retry after configuring it yourself.

**Real model execution and real Codex tool-permission handling have not been validated end to end.** The passing execution tests use the fake ACP process. An earlier isolated real-adapter probe completed only `initialize`, with no login, session creation or prompt.

When running separate real processes, use the same workspace, fake/real mode and authentication configuration in both. The claim response contains the platform's fixed workspace/mode; a mismatched connector fails before launching ACP.

Both entrypoints read an optional `.env`; `.env.example` documents the settings. Actual `.env` files are ignored and excluded from source deliverables.

| Setting                 | Default / meaning                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `PORT`                  | `60390`, limited to 60001–65535; the server always binds to `127.0.0.1`.           |
| `TASK_WORKSPACE`        | Required and existing in real mode; must match between platform and connector.     |
| `TASK_DB`               | `./var/tasks.sqlite`, opened only by the platform.                                 |
| `TASK_CONNECTOR`        | Automatically starts one connector by default; `manual` runs only the platform.    |
| `TASK_PLATFORM_URL`     | Connector address, default `http://127.0.0.1:60390`; loopback HTTP root URLs only. |
| `FAKE_ACP`              | `1` selects the no-model test process; must match in both processes.               |
| `TASK_AUTH`             | `existing` or explicit `api-key`.                                                  |
| `CODEX_HOME` / API keys | Forwarded to the adapter for real execution; not saved as task data.               |

## MCP connection and task format

- Transport: **Streamable HTTP**
- URL: **http://127.0.0.1:60390/mcp**
- Only tool: **`publish_task`**

Start the local platform first. For a Codex CLI client, add it yourself:

```bash
codex mcp add Mingting --url http://127.0.0.1:60390/mcp
codex mcp list
```

Alternatively, merge this into your own `~/.codex/config.toml`; preserve existing settings:

```toml
[mcp_servers.Mingting]
url = "http://127.0.0.1:60390/mcp"
```

See the [official MCP configuration reference](https://developers.openai.com/resources/docs-mcp). Other clients use different files and configuration structures; select HTTP/Streamable HTTP. This project does not modify client configuration automatically.

Tool-call parameters:

```json
{
  "name": "publish_task",
  "arguments": {
    "title": "Improve installation instructions",
    "description": "Review the README and explain installation and startup.",
    "publisherName": "Lin"
  }
}
```

Input schema; all strings are trimmed before application validation:

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "minLength": 1, "maxLength": 160 },
    "description": { "type": "string", "minLength": 1, "maxLength": 16000 },
    "publisherName": { "type": "string", "minLength": 1, "maxLength": 80 }
  },
  "required": ["title", "description", "publisherName"],
  "additionalProperties": false
}
```

Successful `structuredContent` is `{"taskId":"<UUID>"}`. Publishing does not require an open web page or an online connector. The repository includes an official SDK client example:

```bash
npm run publish -- "Improve installation instructions" "Document installation and startup" "Lin"
```

MCP does not expose subscription, approval, arbitrary-command or workspace-selection tools. Publisher names are display text, not authenticated identities. Repeating publication creates another task; publishing itself is not idempotent.

## Task subscription, claims and reports

To observe the real event stream without claiming or executing:

```bash
curl -N http://127.0.0.1:60390/connector/events
```

Resume after the last complete event ID:

```bash
curl -N -H 'Last-Event-ID: 12' http://127.0.0.1:60390/connector/events
```

The cursor must be within the current database's valid range. Future or non-integer cursors are rejected. Watching this stream is not equivalent to running the execution connector.

| Endpoint                                                  | Purpose                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /connector/events`                                   | SSE replay/live stream; `Last-Event-ID` or `?after=`, default 0.                                          |
| `POST /connector/claim`                                   | `{taskId, ownerId, claimId}`; atomically return the task, run, fixed workspace/mode and lease duration.   |
| `POST /connector/runs/:id/heartbeat`                      | `{ownerId, claimId}`; renew the lease and read cancellation state.                                        |
| `POST /connector/runs/:id/report`                         | `{ownerId, claimId, seq, update}`; ordered/idempotent session, discovery, notification and final reports. |
| `POST /connector/runs/:id/permissions`                    | Forward the original ACP request ID and `RequestPermissionRequest`.                                       |
| `POST /connector/runs/:id/permissions/:approvalId/result` | Read the human decision; pending does not authorize an operation.                                         |

SSE event:

```text
id: 42
event: task.available
data: {"id":42,"type":"task.available","taskId":"<UUID>","createdAt":"<ISO timestamp>"}

```

Connector routes accept trusted local CLI clients and reject browser Origin/Sec-Fetch-Site requests. Ownership is bound to `runId + ownerId + claimId`; the complete claim capability is not exposed in the interface or SSE payload. Do not forward claim IDs to unrelated processes. These identifiers are not model credentials or a multi-user identity system.

Application schemas and derived types live in `src/shared/protocol.ts`. ACP payloads use the official SDK and its bundled JSON Schema, validated with Ajv when forwarded over HTTP.

## Reliability, waiting and failures

- Tasks and availability events commit in one SQLite transaction, before delivery. Offline work is retained.
- Delivery is **at least once**. Persistent increasing IDs allow replay; duplicate notifications do not mean duplicate execution.
- Atomic claims allow only one current run per task and one unreleased run globally. Repeating the same owner/claim ID returns the same run; other owners cannot update it.
- Only the subscription connector executes claimed work. The former direct server execution path has been removed.
- Reports carry increasing sequence numbers. Accepted duplicates have no repeated effect; gaps are rejected. Only an ACP `end_turn` followed by a successful final report marks the task `succeeded`.
- The connector renews every second; the lease defaults to 8 seconds, including during approval waits. Failed heartbeats/reporting stop the original ACP execution. Expiry interrupts the run, expires old approvals and releases the slot. Interrupted tasks are not rerun automatically.
- Restart invalidates old ownership and pending approvals, then reannounces queued tasks. When old execution existed, a persisted recovery wait of up to 8 seconds lets old connectors stop before new claims.
- Disconnecting the event stream triggers replay/reconnect; a running task is governed independently by its heartbeat. Ownership fencing cannot undo completed edits and does not provide exactly-once file side effects or transactional rollback.

`queued` means waiting for a connector or the current slot. `awaiting_approval` is intentional human waiting; because execution is serial, later tasks wait too. Allow, reject or cancel the request; approval times out after 10 minutes. Cancellation shows a stopping state until execution is released, then enables retry. Total run timeout is 30 minutes. Cleanup uses ACP cancellation, stdin EOF and bounded process-group SIGTERM/SIGKILL when necessary.

A failed/offline connector must be started again to claim further tasks. The lease prevents an abandoned run from owning the slot forever; it cannot execute work without an online connector.

Decisions use the original option ID for the same ACP request. Repeated, stale or wrong-session approvals are rejected. Closing the browser does not approve anything. Execution is fixed to `workspace-write`, `on-request` and a human reviewer. Only permission requests actually emitted by Codex appear for approval; ordinary sandbox-allowed work is not guaranteed to ask per operation.

## Local security and limits

This is a trusted local, single-user MVP, not remote multi-user hosting. It validates loopback peers and Host/Origin; browser mutations require an HttpOnly/SameSite session cookie and CSRF token. Connector routes reject browser requests and validate claim ownership. Other trusted processes on the same machine are within the trust boundary. Do not expose it through a public proxy, tunnel or an unauthenticated `0.0.0.0` binding. A responsive mobile layout does not enable cross-device access.

Limits are centralized in `src/shared/protocol.ts`: 100 active tasks, the latest 200 list entries, 20 runs per task, 100 approvals per run/16 pending, 300 stored ACP session events and 64000 output characters per run. HTTP bodies are capped at 128 KiB, ACP messages at 1 MiB, HTTP concurrency at 24, subscriptions at 8 and queued reports at 256. Task-availability history currently has no pruning or per-consumer durable offsets; replay can include completed tasks, which the claim endpoint skips. Use only one platform instance per database.

## Verification and source layout

```bash
npm test
npm run build
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium npm run test:ui
```

MVP 0.2 passed 21 backend/subscription integration tests, four desktop/mobile browser tests and TypeScript/Vite build checks. These include actual HTTP MCP/SSE, a separate connector process and fake ACP processes, including cancellation of a deliberately unresponsive child. See the [detailed test report](docs/TEST-REPORT.md) for limits and evidence. No real model or real Codex tool-permission end-to-end result is claimed.

- `src/shared/protocol.ts`: schemas, derived types and limits.
- `src/server/`: SQLite task state, HTTP/MCP/subscription endpoints, approval handling and Codex ACP adapter.
- `src/connector/`: SSE reception, claims, heartbeats, ACP execution and reporting.
- `src/web/`: task list, publishing form and human approvals.
- `scripts/publish-task.ts`: MCP SDK client example.
- `tests/`: real transports with fake ACP execution.

Source deliverables exclude `node_modules`, `.env`, credentials, runtime databases and browser/task state. They do not include another project or the private Site preview source.

Upstream projects: [Codex ACP](https://github.com/agentclientprotocol/codex-acp), [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
