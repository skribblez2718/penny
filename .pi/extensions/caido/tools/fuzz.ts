import type { Client } from "@caido/sdk-client";
import { CREATE_AUTOMATE_SESSION, GET_AUTOMATE_SESSION, START_AUTOMATE_TASK } from "../graphql.js";
import type {
  CreateAutomateSessionResult,
  CreateAutomateSessionVars,
  GetAutomateSessionResult,
  GetAutomateSessionVars,
  StartAutomateTaskResult,
  StartAutomateTaskVars,
} from "../graphql.js";

export interface CaidoFuzzParams {
  request_id?: string;
  automate_session_id?: string;
  payloads?: string[];
}

export async function caidoFuzzImpl(params: CaidoFuzzParams, client: Client): Promise<unknown> {
  let sessionId = params.automate_session_id;

  if (!sessionId) {
    if (!params.request_id) throw new Error("request_id or automate_session_id is required");
    const createResult = await client.graphql.mutation<
      CreateAutomateSessionResult,
      CreateAutomateSessionVars
    >(CREATE_AUTOMATE_SESSION, {
      input: { requestSource: { id: params.request_id } },
    });
    const session = createResult.createAutomateSession.session;
    sessionId = session.id;
  }

  // Verify session exists
  const check = await client.graphql.query<GetAutomateSessionResult, GetAutomateSessionVars>(
    GET_AUTOMATE_SESSION,
    { id: sessionId }
  );
  const session = check.automateSession;
  if (!session) throw new Error(`Automate session ${sessionId} not found`);

  // Start fuzzing
  const startResult = await client.graphql.mutation<StartAutomateTaskResult, StartAutomateTaskVars>(
    START_AUTOMATE_TASK,
    { automateSessionId: sessionId }
  );
  const task = startResult.startAutomateTask.automateTask;

  return {
    sessionId,
    taskId: task.id,
    status: "started",
    note: "Task started successfully. Check Caido UI for progress.",
  };
}
