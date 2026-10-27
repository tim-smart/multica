package main

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// steerTarget is one running turn a comment is added to.
type steerTarget struct {
	TaskID    string
	AgentID   string
	AgentName string
}

// resolveSteerTargets turns --steer run IDs and --steer-active into the runs
// the comment is sent to. Every target must be an in-flight run of this issue,
// and the caller's own runs are never targets: the server refuses a self-steer.
// --steer-active relies on the server's can_supplement, which for an agent
// caller is true only on runs of workers in a squad it leads.
func resolveSteerTargets(ctx context.Context, client *cli.APIClient, issueID string, inputs []string, active bool) ([]steerTarget, error) {
	if len(inputs) == 0 && !active {
		return nil, nil
	}
	var runs []map[string]any
	if err := client.GetJSON(ctx, "/api/issues/"+url.PathEscape(issueID)+"/task-runs?active=true", &runs); err != nil {
		return nil, fmt.Errorf("list active runs: %w", err)
	}
	selfTask, selfAgent := os.Getenv("MULTICA_TASK_ID"), os.Getenv("MULTICA_AGENT_ID")
	isSelf := func(run map[string]any) bool {
		return (selfTask != "" && strVal(run, "id") == selfTask) || (selfAgent != "" && strVal(run, "agent_id") == selfAgent)
	}
	byID := make(map[string]map[string]any, len(runs))
	for _, run := range runs {
		byID[strVal(run, "id")] = run
	}

	var targets []steerTarget
	seen := make(map[string]bool)
	add := func(run map[string]any) {
		id := strVal(run, "id")
		if seen[id] {
			return
		}
		seen[id] = true
		targets = append(targets, steerTarget{TaskID: id, AgentID: strVal(run, "agent_id")})
	}
	for _, input := range inputs {
		ref, err := resolveTaskRunID(ctx, client, issueID, input)
		if err != nil {
			return nil, fmt.Errorf("resolve --steer %s: %w", input, err)
		}
		run, ok := byID[ref.ID]
		if !ok {
			return nil, fmt.Errorf("--steer %s: run is not in flight on this issue; post a normal comment instead", input)
		}
		if isSelf(run) {
			return nil, fmt.Errorf("--steer %s: an agent cannot steer its own run", input)
		}
		add(run)
	}
	if active {
		for _, run := range runs {
			if strVal(run, "status") != "running" || strVal(run, "supplement_capability") != protocol.DaemonCapabilityTaskSupplementV1 ||
				run["can_supplement"] != true || isSelf(run) {
				continue
			}
			add(run)
		}
		if len(targets) == 0 {
			fmt.Fprintln(os.Stderr, "No running run on this issue that you may steer; posting a normal comment.")
		}
	}
	for i := range targets {
		targets[i].AgentName = steerAgentName(ctx, client, targets[i].AgentID)
	}
	return targets, nil
}

func steerAgentName(ctx context.Context, client *cli.APIClient, agentID string) string {
	var agent map[string]any
	if err := client.GetJSON(ctx, "/api/agents/"+url.PathEscape(agentID), &agent); err == nil {
		if name := strings.TrimSpace(strVal(agent, "name")); name != "" {
			return name
		}
	}
	return "agent"
}

// withSteerMentions makes every steered agent a recipient of the comment.
// The server only steers agents the comment triggers, and an agent's comment
// triggers only the agents it mentions; the mention is also what falls back
// to a normal trigger, behind the same invoke check, when the turn cannot
// take the message.
func withSteerMentions(content string, targets []steerTarget) string {
	var prefix []string
	mentioned := make(map[string]bool)
	for _, target := range targets {
		if mentioned[target.AgentID] || strings.Contains(content, "mention://agent/"+target.AgentID+")") {
			continue
		}
		mentioned[target.AgentID] = true
		name := strings.NewReplacer("[", "", "]", "").Replace(target.AgentName)
		prefix = append(prefix, fmt.Sprintf("[@%s](mention://agent/%s)", name, target.AgentID))
	}
	if len(prefix) == 0 {
		return content
	}
	return strings.Join(prefix, " ") + " " + content
}

// reportSteerOutcomes says, per target, whether the running turn took the
// message or the agent got the normal trigger instead.
func reportSteerOutcomes(w io.Writer, targets []steerTarget, result map[string]any) {
	outcomes, _ := result["trigger_outcomes"].([]any)
	for _, target := range targets {
		status, reason := "not_triggered", ""
		for _, raw := range outcomes {
			outcome, ok := raw.(map[string]any)
			if ok && strVal(outcome, "target_type") == "agent" && strVal(outcome, "target_id") == target.AgentID {
				status, reason = strVal(outcome, "status"), strVal(outcome, "reason_code")
				break
			}
		}
		switch status {
		case "steered":
			fmt.Fprintf(w, "Steered run %s (%s): the running turn receives this comment.\n", target.TaskID, target.AgentName)
		case "blocked":
			fmt.Fprintf(w, "Not steered run %s (%s): blocked (%s); the agent was not triggered.\n", target.TaskID, target.AgentName, reason)
		case "not_triggered":
			fmt.Fprintf(w, "Not steered run %s (%s): the comment did not trigger this agent.\n", target.TaskID, target.AgentName)
		default:
			fmt.Fprintf(w, "Not steered run %s (%s): %s; the agent handles this comment in a follow-up run.\n", target.TaskID, target.AgentName, status)
		}
	}
}
