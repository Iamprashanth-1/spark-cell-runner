# Spark Cell Runner — Launch Playbook

Applied from the 30-day open-source launch guide + README conversion guide
(reviewed 2026-10). Work top to bottom; items marked **[you]** need your
accounts/action, everything else is done or one command.

## Where we stand (conversion audit)

| Checklist item | Status |
| --- | --- |
| First line says what it does + for whom | ✅ positioning line above the fold |
| Copy-paste install ABOVE the fold | ✅ 4-line clone/package/install block |
| ≤ 5 functional badges | ✅ 4 badges |
| Hero visual | ✅ `docs/images/hero.png` (dark VS Code-style panel + output) |
| Quickstart ≤ 3 steps with expected output | ✅ 3 steps, real outputs shown |
| Comparison to the obvious alternative | ✅ Databricks-vs-local table + official-extension paragraph |
| Standard headings for AI extraction | ✅ Install/Usage/Configuration/Troubleshooting |
| License + description + topics | ✅ MIT; topics/description set on GitHub |
| "good first issue" labels, CONTRIBUTING | ✅ CONTRIBUTING section in README; **[you]** add labels after first issues arrive |
| Clean-machine first run verified | ✅ every feature E2E-tested on this machine during development |
| Sponsorship | **[you]** enable GitHub Sponsors when ready — optional, day-one not required |

## Pre-launch (Days 1–7)

1. **Attach the vsix to a GitHub Release** (5 min) **[you]**:
   - Releases → *Draft a new release* → tag `v0.6.5` → title `v0.6.5`
   - Attach `spark-cell-runner-0.6.5.vsix`, publish.
   - Then swap the README install block to the one-liner:
     ```bash
     curl -LO https://github.com/Iamprashanth-1/spark-cell-runner/releases/download/v0.6.5/spark-cell-runner-0.6.5.vsix
     code --install-extension spark-cell-runner-0.6.5.vsix
     ```
2. **Publish to the Marketplace** (removes the install friction entirely):
   follow [PUBLISHING.md](PUBLISHING.md) — publisher + PAT + `npx vsce publish`.
   Then put the marketplace link in the repo *Website* field.
3. **Record a 60-second demo** **[you]**: pool start → run a cell → Ctrl+Enter
   SQL → results. Screen-record VS Code; the hero image shows the frames.
4. **Three description lengths** (ready to paste):
   - One line: *Run Databricks notebook-source files and SQL in VS Code — on Databricks, or fully offline on a local Sail Spark pool.*
   - Short (PH/tagline): *Offline Databricks notebook development in VS Code. Local Sail Spark pool, Unity Catalog sync, SQL on a local Delta warehouse — no cloud required.*
   - Para (Reddit/HN body opener): *I kept losing time to serverless connection failures, so I built a VS Code extension that runs Databricks notebook-source files either against Databricks or fully offline on a local Spark pool (Apache Sail). Same dbutils shim, same magics; you can sync a slice of your dev Unity Catalog down and query it with plain SQL. MIT.*
5. **Technical post** (the interesting-design-decision piece): *"Making
   Databricks notebooks run offline: a session-scoped metastore, a warehouse
   registry, and Spark Connect"* — the Sail session-scoped metastore →
   re-register-on-disk-tables story is genuinely interesting content.
6. **Pick the date**: Tue–Thu, avoid US holidays.

## Launch day (Day 8)

In this order; answer every comment all day:

1. **Show HN**: `Show HN: Spark Cell Runner – run Databricks notebooks offline in VS Code`.
   First comment: why you built it, what it does NOT do (no cloud compute, not
   a replacement for real jobs). Stay in the thread.
2. **Product Hunt** same morning with the demo video + maker comment.
3. **Reddit as an ANSWER, not an announcement**: r/databricks,
   r/dataengineering, r/apachespark have recurring "local dev without a
   cluster / serverless pain" questions — answer those with your story and
   the link, disclose authorship. Do not post a bare announcement.
4. **daily.dev squad**: share the technical post.
5. **LinkedIn/X**: the para-length description + hero image.

## Week 1 (Days 9–14)

- Ship visible fixes; announce them in the threads that raised them.
- Follow-up post: what launch taught you, what's next.
- Pitch Databricks-adjacent newsletters with the two-line + repo link.

## Month 1 (Days 15–30)

- One tutorial/week, cross-posted (dev.to, Hashnode): "Offline Databricks dev
  in VS Code", "Unity Catalog sync workflow", "SQL against a local Delta
  warehouse".
- Short YouTube walkthrough (AI assistants cite video pages too).
- GitHub Discussions once strangers file issues; until then, issues = community.

## Metrics that matter

Stars are vanity. Watch: repo **unique visitors/clones**, **vsix downloads +
marketplace installs**, star *velocity* after posts, and the first
stranger-filed issue. Judge at 90 days.

## Mistakes to avoid (from the guide)

No friend-upvote asks (HN/PH detect it) · no announcement-style Reddit posts ·
don't go quiet after day one · don't measure stars · never hide authorship.
