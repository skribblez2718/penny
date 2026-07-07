/** GraphQL documents for features not yet in the high-level SDK.
 *  Uses gql tagged templates for proper TypedDocumentNode compatibility.
 */

import { gql } from "graphql-tag";
export { gql };

/** Result/variable shapes for the raw GraphQL documents below.
 *  These mirror each document's selection set so call sites can pass them
 *  as explicit type arguments to `client.graphql.query/mutation`, which is
 *  generic over `<TData, TVars>`. Variable shapes use `type` aliases (object
 *  literal types) so they satisfy the SDK's `TVars extends Record<string, unknown>`
 *  constraint.
 */

// ── Plugins ──

export interface PluginPackageState {
  running: boolean;
  error?: string | null;
}

export interface PluginPackageEntry {
  id: string;
  manifestId: string;
  name: string;
  enabled: boolean;
  state?: PluginPackageState;
}

export interface PluginPackage {
  id: string;
  manifestId: string;
  name: string;
  version: string;
  plugins: PluginPackageEntry[];
}

export interface PluginPackagesResult {
  pluginPackages: PluginPackage[];
}

// ── Intercept ──

export interface InterceptFilterCode {
  code: string;
}

export interface InterceptDirectionOptions {
  enabled: boolean;
  filter?: InterceptFilterCode | null;
}

export interface InterceptOptionsResult {
  interceptOptions: {
    request: InterceptDirectionOptions;
    response: InterceptDirectionOptions;
    scope: { scopeId: string | null };
  };
}

export interface PauseInterceptResult {
  pauseIntercept: { status: string };
}

export interface ResumeInterceptResult {
  resumeIntercept: { status: string };
}

// ── Automate / Fuzz ──

export interface AutomateSessionConnection {
  host: string;
  port: number;
  isTLS: boolean;
}

export interface AutomateSession {
  id: string;
  name: string;
  connection: AutomateSessionConnection;
  raw: string;
}

export interface CreateAutomateSessionResult {
  createAutomateSession: { session: AutomateSession };
}

export type CreateAutomateSessionVars = {
  input: { requestSource: { id: string } };
};

export interface GetAutomateSessionResult {
  automateSession:
    | (AutomateSession & {
        settings: { payloads: Array<{ options: { list?: string[] } }> };
      })
    | null;
}

export type GetAutomateSessionVars = {
  id: string;
};

export interface StartAutomateTaskResult {
  startAutomateTask: { automateTask: { id: string; paused: boolean } };
}

export type StartAutomateTaskVars = {
  automateSessionId: string;
};

// ── Replay: create session with raw source ──

export interface CreateReplaySessionRawResult {
  createReplaySession: { session: { id: string; name: string } };
}

export type CreateReplaySessionRawVars = {
  input: {
    requestSource: {
      raw: {
        connectionInfo: { host: string; port: number; isTLS: boolean };
        raw: string;
      };
    };
  };
};

// ── Plugins ──

export const PLUGIN_PACKAGES_QUERY = gql`
  query {
    pluginPackages {
      id
      manifestId
      name
      version
      plugins {
        ... on PluginBackend {
          id
          manifestId
          name
          enabled
          state {
            running
            error
          }
        }
        ... on PluginFrontend {
          id
          manifestId
          name
          enabled
        }
        ... on PluginWorkflow {
          id
          manifestId
          name
          enabled
        }
      }
    }
  }
`;

// ── Intercept ──

export const INTERCEPT_OPTIONS_QUERY = gql`
  query {
    interceptOptions {
      request {
        enabled
        filter {
          ... on HTTPQL {
            code
          }
          ... on StreamQL {
            code
          }
        }
      }
      response {
        enabled
        filter {
          ... on HTTPQL {
            code
          }
          ... on StreamQL {
            code
          }
        }
      }
      scope {
        scopeId
      }
    }
  }
`;

export const PAUSE_INTERCEPT = gql`
  mutation {
    pauseIntercept {
      status
    }
  }
`;

export const RESUME_INTERCEPT = gql`
  mutation {
    resumeIntercept {
      status
    }
  }
`;

// ── Automate / Fuzz ──

export const CREATE_AUTOMATE_SESSION = gql`
  mutation ($input: CreateAutomateSessionInput!) {
    createAutomateSession(input: $input) {
      session {
        id
        name
        connection {
          host
          port
          isTLS
        }
        raw
      }
    }
  }
`;

export const GET_AUTOMATE_SESSION = gql`
  query ($id: ID!) {
    automateSession(id: $id) {
      id
      name
      connection {
        host
        port
        isTLS
      }
      raw
      settings {
        payloads {
          options {
            ... on AutomateSimpleListPayload {
              list
            }
          }
        }
      }
    }
  }
`;

export const START_AUTOMATE_TASK = gql`
  mutation ($automateSessionId: ID!) {
    startAutomateTask(automateSessionId: $automateSessionId) {
      automateTask {
        id
        paused
      }
    }
  }
`;

// ── Replay: create session with raw source ──

export const CREATE_REPLAY_SESSION_RAW = gql`
  mutation ($input: CreateReplaySessionInput!) {
    createReplaySession(input: $input) {
      session {
        id
        name
      }
    }
  }
`;
