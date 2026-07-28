---
layout: default
title: Agent Wind Tunnel — Alternatives and complements
description: When to use prompts, subagents, workflow frameworks, eval platforms, or topology search.
---

# Alternatives and complements

Agent Wind Tunnel is one layer in an agent engineering stack. It is useful
when topology itself is a decision variable. It is unnecessary when the task
does not justify a controlled architecture study.

## Start with the decision

| Need | Smallest appropriate tool |
| --- | --- |
| One person needs a result now | Ask a capable model directly |
| A one-off task benefits from parallel perspectives | Prompt the coding/chat agent to create bounded subagents |
| A repeatable procedure needs specialized instructions | Use a versioned prompt, skill, or application workflow |
| A model needs approved access to external data/actions | Add tools or MCP servers behind explicit permissions |
| A production agent needs traces and graders | Use an evaluation/observability platform |
| A fixed multi-step process must run reliably | Use a workflow/agent framework and ordinary software tests |
| A team must choose among several bounded architectures | Use a matched experiment such as Agent Wind Tunnel |
| A research system should invent or optimize graph structure | Use architecture-search research with a separate safety sandbox |

The most sophisticated option is not automatically the most appropriate one.

## Direct prompting

Use a direct prompt when:

- the task is reversible and low consequence;
- the user can inspect the result;
- context fits in one interaction;
- there is no need to reproduce an internal route;
- one model call meets the quality and latency requirement.

Advantages: minimal implementation, latency, and operational surface.

Limitations: little process-level control, limited repeatability, and no
evidence about whether more structure would help.

Agent Wind Tunnel deliberately includes `direct` as the baseline. If it passes,
additional orchestration has not earned its burden in that study.

## Prompt-created subagents

Asking Codex, Claude, or another agent to create reviewers or workers is useful
for exploration and one-off work. The parent agent can adapt the number and
roles dynamically to the task.

Choose this when flexibility is more valuable than a fixed, externally
auditable route. Do not mistake it for the same artifact as Agent Wind Tunnel:

- the orchestrator may invent roles at runtime;
- route and retry limits may be prompt-level rather than compiled;
- permissions remain those of the containing harness;
- comparing two runs can confound task, topology, and model decisions;
- the resulting collaboration is evidence about that run, not a reusable
  architecture benchmark.

Use a scripted, bounded graph when the workflow must be repeatable, reviewed,
tested, or governed.

## Skills, hooks, tools, and MCP

These mechanisms solve different problems:

- **Skill:** reusable instructions and assets for how an agent should perform a
  class of task.
- **Hook:** deterministic code triggered at a lifecycle event.
- **Tool:** an operation the model can request through a controlled interface.
- **MCP server:** a standard way to expose tools, resources, or prompts across
  compatible clients.
- **Workflow graph:** control flow, state transitions, retries, joins, and
  authority boundaries.
- **Evaluation harness:** scenarios, graders, repetitions, comparisons, and
  decision rules.

Agent Wind Tunnel is primarily an evaluation harness plus a constrained
workflow compiler. It can compare workflows that call skills or tools, but it
does not replace those mechanisms.

## Workflow and agent frameworks

Frameworks such as the OpenAI Agents SDK, Microsoft Agent Framework, LangGraph,
Google Agent Development Kit, and Inspect AI provide production or evaluation
building blocks for agents, handoffs, tools, workflows, or multi-agent tasks.

Use a framework when the architecture is already chosen and must be built,
served, observed, or integrated.

Agent Wind Tunnel can precede or complement that work:

1. compare a small set of architecture hypotheses;
2. select the smallest feasible family;
3. implement the selected workflow in the organization’s runtime;
4. retain the Wind Tunnel scenario suite as an architectural regression test.

The current implementation owns its topology so the comparison stays visible.
It is not a drop-in runtime for arbitrary framework graphs.

Primary references:

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [Microsoft Agent Framework workflows](https://learn.microsoft.com/en-us/agent-framework/workflows/)
- [LangGraph](https://langchain-ai.github.io/langgraph/)
- [Google Agent Development Kit](https://google.github.io/adk-docs/)
- [Inspect AI agents](https://inspect.aisi.org.uk/agents.html)

## Evaluation and observability platforms

OpenAI Agent Evals and trace grading, LangSmith, Braintrust, Arize Phoenix, and
Promptfoo can store datasets, run experiments, grade outputs or trajectories,
compare versions, and inspect traces.

These platforms generally evaluate an application or workflow supplied by the
user. They are complementary to Agent Wind Tunnel’s narrower decision model:
declare a bounded candidate set, validate graph/authority invariants, and
select the minimum feasible topology.

A production pilot should usually export Wind Tunnel runs to an established
trace/evaluation system instead of rebuilding every grader and dashboard.

Primary references:

- [OpenAI Agent Evals](https://developers.openai.com/api/docs/guides/agent-evals)
- [OpenAI trace grading](https://developers.openai.com/api/docs/guides/trace-grading)
- [LangSmith evaluation](https://docs.langchain.com/langsmith/evaluation)
- [Braintrust evaluation](https://www.braintrust.dev/docs/evaluate)
- [Arize Phoenix datasets and experiments](https://arize.com/docs/phoenix/datasets-and-experiments/overview)
- [Promptfoo tracing](https://www.promptfoo.dev/docs/tracing/)

## Policy and authorization systems

Real IAM, policy engines, secret managers, sandboxes, approval services, and
deployment controllers protect production resources. They should remain
independent of model reasoning and model-generated graphs.

The Wind Tunnel authority broker demonstrates:

- a graph cannot invent a catalogued capability;
- a node request must remain inside initial grants;
- a consequential effect route needs a dominating approval node;
- an approval is bound to one simulated effect.

It does not authenticate a person, issue cloud credentials, isolate a process,
or execute a deployment. Use a real policy/enforcement system for those jobs.

## Ordinary software testing

Unit, integration, property, mutation, security, load, and end-to-end tests
remain necessary. Agent evaluation does not replace them.

Agent Wind Tunnel itself relies on ordinary deterministic tests for its
strongest implementation claims. Executable requirements are generally
stronger evidence than a model’s self-assessment.

## Dynamic graph and agent-architecture search

Research systems can optimize prompts, graph connectivity, or even generate
new agent code. Examples include GPTSwarm and AgentSquare/ADAS-style agent
search.

That objective differs from Agent Wind Tunnel:

| Agent Wind Tunnel | Dynamic architecture search |
| --- | --- |
| Fixed, declared candidate set | Candidate structure may be generated or mutated |
| Closed roles, routes, contracts, and capabilities | Search space can expand at runtime |
| Reject unsupported behavior | Execute or evaluate newly proposed behavior |
| Select minimum feasible declared candidate | Optimize a reward across discovered candidates |
| Designed for inspectability and bounded comparison | Designed for exploration and optimization |

Architecture search can be valuable research, but model-generated code or
permissions need a separate sandbox, restricted capability broker, evaluation
budget, and human release process.

Primary references:

- [GPTSwarm](https://github.com/metauto-ai/GPTSwarm)
- [AgentSquare](https://github.com/tsinghua-fib-lab/AgentSquare)
- [Automated Design of Agentic Systems](https://github.com/ShengranHu/ADAS)

## When not to use Agent Wind Tunnel

Do not use this project as the primary tool when:

- one direct call already meets a low-risk need;
- the architecture is fixed by product or regulatory constraints;
- the main problem is prompt quality rather than topology;
- the team needs production serving, tracing, or IAM rather than a comparison;
- there are no representative scenarios or meaningful acceptance gates;
- the candidate designs cannot be made comparable;
- dynamic exploration is the research objective;
- a decision must be based on real business outcomes but only synthetic
  fixtures are available.

## Practical stack

A realistic organization may use all of these layers:

```text
skills/prompts + tools/MCP
          │
          ▼
workflow or agent framework
          │
          ▼
runtime IAM, sandbox, approval, secrets
          │
          ▼
tracing, datasets, graders, incident telemetry
          │
          ▼
Agent Wind Tunnel-style topology comparison
          │
          ▼
architecture decision and regression suite
```

The Wind Tunnel does not replace the stack. It makes one cross-cutting
architecture decision explicit and testable.
