'use strict';

// Concrete representatives of the fixed whole-text owner bindings. The
// composed migration test adds record, retained and native-owner cases.
const wholeTextCases = [
  ['session-head','sessions/sess_one.json'], ['session-scratchpad','sessions/sess_one.scratchpad.json'],
  ['session-index','sessions/index.json','array'], ['session-v1-backup','sessions/sess_one.json.v1bak'],
  ['journal-index','checkpoints/sess_one/index.json','array'], ['journal-reverts','checkpoints/sess_one/reverts.json'],
  ['mission-container','missions/mission_one.json'], ['pretender-index','sessions/.pretender/projection-index.json'],
  ['memory-body','memory/global/note.md','markdown'], ['memory-meta','memory/project/0123456789abcdef/meta.json'],
  ['memory-usage','memory/_usage-v1.json'], ['memory-relations','memory/project/0123456789abcdef/_relations.json','array'],
  ['memory-proposals','memory/proposals/sess_one.json'], ['agent-instructions-import','memory/.agent-instructions-import-v1.json'],
  ['steward-memory','steward/memory-v1.json'], ['steward-visits','steward/visits/2026-10-24T12-00-00-000Z.json'],
  ['voice-lexicon','voice-lexicon.json'], ['steward-cursor','steward/cursor-v1.json'],
  ['external-bots','external-bots/state-v1.json'], ['scheduler-tasks','scheduler/tasks-v1.json'],
  ['agent-run-snapshot','agent-runs/sess_one/run_one.json'], ['background-job-ledger','sessions/background-jobs/sess_one.json','array'],
  ['personal-workflows','agent-workflows/Display 不同.json'], ['playbooks','playbooks/Display 不同.json'],
  ['session-search-index','sessions/_search-index-v1.json'], ['web-cache','webcache/'+'e'.repeat(64)+'.json'],
  ['proxy-models-cache','proxy-models-cache.json'], ['engine-transcript-index','engine-transcripts.json'],
  ['migration-log','migrations/2026-10-24T12-00-00-000Z.json'], ['skill-import-record','skills/tool_one/.ruyi-import.json'],
];

module.exports = { wholeTextCases };
