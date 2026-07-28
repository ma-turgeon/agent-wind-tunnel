# Independent-review kit

This kit is optional. It does not convert the checked-in composite cases into
independent evidence unless reviewers complete it without seeing fixture
defects or expected winners.

## Reviewer instructions

1. Read `dossiers.json` only. Do not inspect `calibration.json`,
   `held-out.json`, generated results, or baselines before scoring.
2. Treat normalized capacity points as comparative planning units—not dollars,
   hours, staff counts, or promised savings.
3. Score each initiative from 1 (weak) to 5 (strong) for strategic alignment,
   expected benefit, delivery/data readiness, and reversibility.
4. Score each initiative from 1 (low) to 5 (high) for dependency, privacy,
   security, fairness/impact, and oversight burden.
5. State the evidence needed before a real decision. Do not invent missing
   organizational facts.
6. Recommend `advance`, `experiment`, `hold`, or `reject`, and identify the
   required governance path.
7. Sign and date the sheet. Record conflicts of interest or prior exposure to
   the expected results.

## Evidence status

Completed sheets are human judgments, not ground truth. Before using them as
grader calibration, measure inter-reviewer agreement, resolve ambiguous rubric
definitions, retain disagreements, and version the resulting label set.

The repository ships no completed sheets and therefore makes no
human-calibration claim.
