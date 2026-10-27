package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// agentCommentRequest posts as agent agentID from its task taskID, the shape
// the auth middleware stamps for a task token.
func agentCommentRequest(issueID, agentID, taskID, content string, steerTaskIDs ...string) *http.Request {
	req := newRequest(http.MethodPost, "/api/issues/"+issueID+"/comments", map[string]any{
		"content": content, "steer_task_ids": steerTaskIDs,
	})
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", agentID)
	req.Header.Set("X-Task-ID", taskID)
	return withURLParam(req, "id", issueID)
}

func TestAgentCommentSteersOnlyItsSquadWorkers(t *testing.T) {
	for _, tc := range []struct {
		name string
		// setup links the caller and the worker and returns the run to steer.
		setup       func(t *testing.T, caller, worker string) (originator string, selfSteer bool)
		wantSteered bool
	}{
		{name: "leader steers its worker", wantSteered: true, setup: func(t *testing.T, caller, worker string) (string, bool) {
			dbfx.SquadMember(t, dbfx.Squad(t, "Crew", caller), "agent", worker)
			return testUserID, false
		}},
		{name: "agent outside the worker's squads", setup: func(t *testing.T, caller, worker string) (string, bool) {
			return testUserID, false
		}},
		{name: "leader of an archived squad", setup: func(t *testing.T, caller, worker string) (string, bool) {
			dbfx.SquadMember(t, dbfx.Squad(t, "Old crew", caller, testutil.Cols{"archived_at": testutil.Raw("now()")}), "agent", worker)
			return testUserID, false
		}},
		{name: "agents leading each other", setup: func(t *testing.T, caller, worker string) (string, bool) {
			dbfx.SquadMember(t, dbfx.Squad(t, "Crew", caller), "agent", worker)
			dbfx.SquadMember(t, dbfx.Squad(t, "Other crew", worker), "agent", caller)
			return testUserID, false
		}},
		{name: "leader whose chain may not invoke the worker", setup: func(t *testing.T, caller, worker string) (string, bool) {
			dbfx.SquadMember(t, dbfx.Squad(t, "Crew", caller), "agent", worker)
			return "", false
		}},
		{name: "leader's own running turn", setup: func(t *testing.T, caller, worker string) (string, bool) {
			dbfx.SquadMember(t, dbfx.Squad(t, "Crew", caller), "agent", worker)
			return testUserID, true
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newSupplementFixture(t, "claude", "running", true)
			dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE issue_id = $1`, f.issueID)
			callerAgent, callerTask := runningSteerableTask(t, f, "steer-caller")
			originator, selfSteer := tc.setup(t, callerAgent, f.agentID)
			if originator == "" {
				dbfx.Exec(t, `UPDATE agent_task_queue SET originator_user_id = NULL, accountable_user_id = NULL, originator_source = NULL WHERE id = $1`, callerTask)
			} else {
				dbfx.Exec(t, `UPDATE agent_task_queue SET originator_user_id = $2, accountable_user_id = $2, originator_source = 'comment_source' WHERE id = $1`, callerTask, originator)
			}
			target, targetTask := f.agentID, f.taskID
			if selfSteer {
				target, targetTask = callerAgent, callerTask
			}

			var created CommentResponse
			testutil.Call(t, testHandler.CreateComment, agentCommentRequest(f.issueID, callerAgent, callerTask,
				agentMention("Target", target)+" only fix web", targetTask)).Want(http.StatusCreated).JSON(&created)

			outcome, ok := outcomeFor(created.TriggerOutcomes, target)
			if !ok {
				t.Fatalf("no outcome for the mentioned agent: %+v", created.TriggerOutcomes)
			}
			if steered := outcome.Status == DispatchSteered; steered != tc.wantSteered {
				t.Fatalf("outcome = %+v, want steered=%v", outcome, tc.wantSteered)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM task_supplement WHERE comment_id = $1`, created.ID); (n == 1) != tc.wantSteered {
				t.Fatalf("stored %d receipts, want steered=%v", n, tc.wantSteered)
			}
		})
	}
}
