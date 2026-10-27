package handler

import (
	"net/http"
	"net/http/httptest"
	"sync"
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

func setTaskOriginator(t *testing.T, taskID, userID string) {
	t.Helper()
	if userID == "" {
		dbfx.Exec(t, `UPDATE agent_task_queue SET originator_user_id = NULL, accountable_user_id = NULL, originator_source = NULL WHERE id = $1`, taskID)
		return
	}
	dbfx.Exec(t, `UPDATE agent_task_queue SET originator_user_id = $2, accountable_user_id = $2, originator_source = 'comment_source' WHERE id = $1`, taskID, userID)
}

func TestAgentCommentSteersOnlyTurnsItMayReach(t *testing.T) {
	for _, tc := range []struct {
		name        string
		originator  string
		selfSteer   bool
		wantSteered bool
	}{
		// B is private to testUserID, the human A works for.
		{name: "agent its originator may invoke", originator: testUserID, wantSteered: true},
		{name: "chain with no human originator", originator: "", wantSteered: false},
		{name: "own running turn", originator: testUserID, selfSteer: true, wantSteered: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newSupplementFixture(t, "claude", "running", true)
			dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE issue_id = $1`, f.issueID)
			callerAgent, callerTask := runningSteerableTask(t, f, "steer-caller")
			setTaskOriginator(t, callerTask, tc.originator)
			target, targetTask := f.agentID, f.taskID
			if tc.selfSteer {
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

func TestAgentSteerLimitHoldsForConcurrentComments(t *testing.T) {
	f := newSupplementFixture(t, "claude", "running", true)
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE issue_id = $1`, f.issueID)
	callerAgent, callerTask := runningSteerableTask(t, f, "steer-flood")
	setTaskOriginator(t, callerTask, testUserID)
	content := agentMention("Target", f.agentID) + " one more thing"

	attempts := maxAgentSupplementsPerRun + 3
	statuses := make([]int, attempts)
	var wg sync.WaitGroup
	for i := range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			testHandler.CreateComment(rec, agentCommentRequest(f.issueID, callerAgent, callerTask, content, f.taskID))
			statuses[i] = rec.Code
		}()
	}
	wg.Wait()

	for i, status := range statuses {
		if status != http.StatusCreated {
			t.Fatalf("comment %d returned %d; a refused steer must not fail the write", i, status)
		}
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM task_supplement WHERE task_id = $1`, f.taskID); n != maxAgentSupplementsPerRun {
		t.Fatalf("the running turn took %d agent messages, want the cap of %d", n, maxAgentSupplementsPerRun)
	}
}
