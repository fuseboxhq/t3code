# Leads

Leads are GitHub issues labelled `lead`: the bugs, tech debt, and ideas your agents notice while working on something else and file for later.
The Leads page collects them from every project across your connected servers, so triage happens where the agents that will fix them already run.

Open it from the target icon in the sidebar footer, or from the command palette with "Open leads".
The entry appears once a connected server supports it.

## The list

Leads are grouped by project, newest activity first, across every connected server.
Filter by open, closed, or all states, and search by title, number, author, or label - the search also asks GitHub itself, so it finds matches in issue bodies and comments the row cannot show.
Rows show the issue state, title, number, author, extra labels, comment count, and age.

Reading leads uses the GitHub CLI's own sign-in on each server.
If a host reports it cannot be read, the page shows what to do about it - usually `gh auth login` on that server.

## The detail panel

Selecting a lead opens it beside the list, with more leads opening as peer tabs.
The panel shows the issue body and comments, lets you comment, and close or reopen the issue - with controls disabled where your GitHub account lacks the access, and the reason shown.
Comment pages load on demand for long conversations, and "Open on GitHub" is always one click away.

## Start working on a lead

"Start working on this" is what makes a lead more than a bookmark: it opens a new thread on the project that holds the repository and pre-fills the composer with the lead - title, link, and description - ready to send to an agent.
Nothing is sent until you send it, and anything you had already typed in that composer survives.
Where more than one project holds the repository, you pick which one takes the work.

The pre-filled task links back to the issue, so the agent can comment on it and close it as part of finishing the job.
