# Agent Skill Reference

## State Machine

### States

| State       | Description                                            | Entry Action                             |
| ----------- | ------------------------------------------------------ | ---------------------------------------- |
| intake      | Validate goal, extract agent name, enforce constraints | Parse goal                               |
| exploring   | Gather agent patterns, schema, conventions             | Invoke echo agents in parallel           |
| designing   | Synthesize agent definition design                     | Invoke piper agents in parallel          |
| critiquing  | Validate design against standard                       | Invoke carren agents in parallel         |
| revising    | Fix design based on critique                           | Route to explore or design               |
| scaffolding | Generate `.pi/agents/<name>.md`                        | Invoke skribble agent                    |
| verifying   | Validate generated file                                | Invoke vera agent                        |
| complete    | Success                                                | Store learnings, return sub-skill result |
| error       | Failure                                                | Log errors                               |

### Transitions

| Transition     | From        | To          | Guard                 |
| -------------- | ----------- | ----------- | --------------------- |
| start          | intake      | exploring   | has_goal              |
| explore_done   | exploring   | designing   | explore_complete      |
| design_done    | designing   | critiquing  | design_complete       |
| critique_pass  | critiquing  | scaffolding | critique_approved     |
| critique_fail  | critiquing  | revising    | has_issues            |
| scaffold_done  | scaffolding | verifying   | generation_complete   |
| verify_pass    | verifying   | complete    | verification_complete |
| verify_fail    | verifying   | scaffolding | verification_failed   |
| revise_explore | revising    | exploring   | needs_more_context    |
| revise_design  | revising    | designing   | can_fix_design        |

## Subagent Integration

| Agent    | Phase    | Input               | Output             | Prompt      |
| -------- | -------- | ------------------- | ------------------ | ----------- |
| echo     | explore  | Goal, agent name    | Findings, patterns | echo.md     |
| vera     | verify   | Generated file path | Validation result  | vera.md     |
| piper    | design   | Explore findings    | Design spec        | piper.md    |
| carren   | critique | Design spec         | Verdict, issues    | carren.md   |
| skribble | scaffold | Design spec         | Generated file     | skribble.md |

## Mempalace

- **Session room**: `skills/agent-<session_id>`
- **Write format**: `## Session: <session_id> — <Phase>` with metadata
- **Read**: Search `skills/agent-<session_id>` for prior results

## Sub-Skill Contract

- Input: `parent_session_id` in constraints
- Return: `{agent_name, agent_definition, file_path, verification_result, confidence}`

## Error Handling

- Invalid summary → safe defaults → error action
- UNCERTAIN confidence → escalation to user
- Max iterations → error action
