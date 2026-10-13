import { deploymentDefaults } from "./deployment";
import { buildInstructions, buildToolDescriptions } from "./rules";

export const SERVER_INFO = { name: deploymentDefaults.name, version: "0.1.0" };
export const INSTRUCTIONS = buildInstructions(deploymentDefaults);
const descriptions = buildToolDescriptions(deploymentDefaults);

export const TOOLS = [
  {
    name: "bridge_send",
    description:
      descriptions.bridge_send,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: descriptions.bridge_send_inputSchema_properties_to },
        new_session: { type: "boolean", description: descriptions.bridge_send_inputSchema_properties_new_session },
        subject: { type: "string", description: descriptions.bridge_send_inputSchema_properties_subject },
        body: { type: "string", description: descriptions.bridge_send_inputSchema_properties_body },
        thread_id: { type: "integer", description: descriptions.bridge_send_inputSchema_properties_thread_id },
      },
      required: ["body"],
    },
  },
  {
    name: "bridge_inbox",
    description:
      descriptions.bridge_inbox,
    inputSchema: {
      type: "object",
      properties: {
        wait_seconds: { type: "integer", description: descriptions.bridge_inbox_inputSchema_properties_wait_seconds },
        peek: { type: "boolean", description: descriptions.bridge_inbox_inputSchema_properties_peek },
      },
    },
  },
  {
    name: "bridge_done",
    description: descriptions.bridge_done,
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "integer" } },
      required: ["message_id"],
    },
  },
  {
    name: "bridge_thread",
    description: descriptions.bridge_thread,
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "integer" } },
      required: ["thread_id"],
    },
  },
  {
    name: "bridge_threads",
    description: descriptions.bridge_threads,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: descriptions.bridge_threads_inputSchema_properties_limit } },
    },
  },
  {
    name: "bridge_help",
    description: descriptions.bridge_help,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_members",
    description: descriptions.bridge_members,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_status_set",
    description: descriptions.bridge_status_set,
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: descriptions.bridge_status_set_inputSchema_properties_state },
        repo: { type: "string", description: descriptions.bridge_status_set_inputSchema_properties_repo },
        branch: { type: "string", description: descriptions.bridge_status_set_inputSchema_properties_branch },
        summary: { type: "string", description: descriptions.bridge_status_set_inputSchema_properties_summary },
      },
      required: ["state"],
    },
  },
  {
    name: "bridge_status",
    description: descriptions.bridge_status,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_sessions",
    description: descriptions.bridge_sessions,
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: descriptions.bridge_sessions_inputSchema_properties_member },
        include: { type: "string", enum: ["ended"], description: descriptions.bridge_sessions_inputSchema_properties_include },
      },
    },
  },
  {
    name: "bridge_session_log",
    description: descriptions.bridge_session_log,
    inputSchema: {
      type: "object",
      properties: { member: { type: "string" }, session: { type: "string", description: descriptions.bridge_session_log_inputSchema_properties_session } },
      required: ["member", "session"],
    },
  },
  {
    name: "task_create",
    description:
      descriptions.task_create,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: descriptions.task_create_inputSchema_properties_title },
        brief: { type: "string", description: descriptions.task_create_inputSchema_properties_brief },
        owner: { type: "string", description: descriptions.task_create_inputSchema_properties_owner },
        assignee: { type: "string", description: descriptions.task_create_inputSchema_properties_assignee },
        repo: { type: "string" },
        branch: { type: "string" },
        priority: { type: "integer", description: descriptions.task_create_inputSchema_properties_priority },
        labels: { type: "array", items: { type: "string" } },
        due: { type: "string", description: descriptions.task_create_inputSchema_properties_due },
        state: { type: "string", description: descriptions.task_create_inputSchema_properties_state },
        kind: { type: "string", enum: ["task", "epic"], description: descriptions.task_create_inputSchema_properties_kind },
        parent: { type: "string", description: descriptions.task_create_inputSchema_properties_parent },
      },
      required: ["title", "brief", "owner"],
    },
  },
  {
    name: "revert",
    description:
      descriptions.revert,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: descriptions.revert_inputSchema_properties_target },
        repo: { type: "string", description: descriptions.revert_inputSchema_properties_repo },
        reason: { type: "string", description: descriptions.revert_inputSchema_properties_reason },
      },
      required: ["target"],
    },
  },
  {
    name: "task_stamp",
    description:
      descriptions.task_stamp,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: descriptions.task_stamp_inputSchema_properties_key },
        merged_sha: { type: "string", description: descriptions.task_stamp_inputSchema_properties_merged_sha },
        deploy_state: { type: "string", description: descriptions.task_stamp_inputSchema_properties_deploy_state },
      },
      required: ["key", "merged_sha"],
    },
  },
  {
    name: "bridge_trust",
    description:
      descriptions.bridge_trust,
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: descriptions.bridge_trust_inputSchema_properties_device },
        person: { type: "string", description: descriptions.bridge_trust_inputSchema_properties_person },
        mode: { type: "string", enum: ["full", "read"], description: descriptions.bridge_trust_inputSchema_properties_mode },
      },
      required: ["device", "person", "mode"],
    },
  },
  {
    name: "kill",
    description:
      descriptions.kill,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: descriptions.kill_inputSchema_properties_session },
        reason: { type: "string", description: descriptions.kill_inputSchema_properties_reason },
      },
      required: ["session"],
    },
  },
  {
    name: "task_list",
    description: descriptions.task_list,
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: descriptions.task_list_inputSchema_properties_scope },
        state: { type: "array", items: { type: "string" }, description: descriptions.task_list_inputSchema_properties_state },
        repo: { type: "string" },
        limit: { type: "integer", description: descriptions.task_list_inputSchema_properties_limit },
      },
    },
  },
  {
    name: "task_get",
    description: descriptions.task_get,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: descriptions.task_get_inputSchema_properties_key }, limit: { type: "integer", description: descriptions.task_get_inputSchema_properties_limit } },
      required: ["key"],
    },
  },
  {
    name: "task_update",
    description:
      descriptions.task_update,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        expected_version: { type: "integer" },
        state: { type: "string", description: descriptions.task_update_inputSchema_properties_state },
        assignee: { type: ["string", "null"], description: descriptions.task_update_inputSchema_properties_assignee },
        priority: { type: "integer", description: descriptions.task_update_inputSchema_properties_priority },
        repo: { type: ["string", "null"] },
        branch: { type: ["string", "null"] },
        pr_url: { type: ["string", "null"] },
        labels: { type: "array", items: { type: "string" }, description: descriptions.task_update_inputSchema_properties_labels },
        add_labels: { type: "array", items: { type: "string" }, description: descriptions.task_update_inputSchema_properties_add_labels },
        remove_labels: { type: "array", items: { type: "string" }, description: descriptions.task_update_inputSchema_properties_remove_labels },
        due: { type: ["string", "null"], description: descriptions.task_update_inputSchema_properties_due },
        parent: { type: ["string", "null"], description: descriptions.task_update_inputSchema_properties_parent },
        kind: { type: "string", enum: ["task", "epic"], description: descriptions.task_update_inputSchema_properties_kind },
        title: { type: "string" },
        brief: { type: "string" },
        note: { type: "string", description: descriptions.task_update_inputSchema_properties_note },
      },
      required: ["key"],
    },
  },
  {
    name: "task_done",
    description:
      descriptions.task_done,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        summary: { type: "string", description: descriptions.task_done_inputSchema_properties_summary },
        branch: { type: "string" },
        pr_url: { type: "string" },
        expected_version: { type: "integer" },
      },
      required: ["key", "summary"],
    },
  },
  {
    name: "task_report",
    description:
      descriptions.task_report,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        verdict: { type: "string", enum: ["finished", "progress", "blocked", "failed"], description: descriptions.task_report_inputSchema_properties_verdict },
        summary: { type: "string", description: descriptions.task_report_inputSchema_properties_summary },
        branch: { type: "string" },
        pr_url: { type: "string" },
        expected_version: { type: "integer" },
      },
      required: ["key", "summary"],
    },
  },
  {
    name: "error_log",
    description:
      descriptions.error_log,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: descriptions.error_log_inputSchema_properties_command }, outcome: { type: "string", description: descriptions.error_log_inputSchema_properties_outcome } },
      required: ["command", "outcome"],
    },
  },
  {
    name: "error_resolve",
    description: descriptions.error_resolve,
    inputSchema: { type: "object", properties: { id: { type: "string", description: descriptions.error_resolve_inputSchema_properties_id }, note: { type: "string" } }, required: ["id"] },
  },
  {
    name: "bridge_faults",
    description: descriptions.bridge_faults,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fire_routine",
    description:
      descriptions.fire_routine,
    inputSchema: {
      type: "object",
      properties: {
        routine: { type: "string", description: descriptions.fire_routine_inputSchema_properties_routine },
        text: { type: "string", description: descriptions.fire_routine_inputSchema_properties_text },
        thread_id: { type: "integer", description: descriptions.fire_routine_inputSchema_properties_thread_id },
        task_key: { type: "string", description: descriptions.fire_routine_inputSchema_properties_task_key },
      },
      required: ["routine", "text"],
    },
  },
];
