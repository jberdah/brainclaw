# Plans and Claims

Plans and claims are where brainclaw starts to feel less like a note system and more like a coordination layer.

## Plans

Plans provide a shared view of intended work.

They help teams and agents answer questions like:

- what are we trying to ship?
- what is in progress?
- what is blocked?
- what is done?
- who is responsible right now?

## Claims

Claims make current ownership explicit.

A claim can represent:

- a file
- a folder
- a feature area
- a work scope linked to a plan item

Claims help reduce collisions when multiple humans or agents work in parallel.

## Why claims matter

Without claims, multiple agents can easily touch the same area at once and generate conflicting changes.
Claims are not necessarily hard file locks.
They are a shared coordination signal.

## Recommended workflow

1. create a plan item
2. claim the target scope
3. work on the implementation
4. update the plan status
5. release the claim when done or blocked
6. create a handoff if another actor should continue

## Session hygiene

Before finishing a session, always:

- release active claims: `brainclaw release-claim <id>`
- update plan items: `brainclaw update-plan <id> --status done`
- or use `brainclaw session-end --auto-release` to clean up automatically

## Plans + claims together

Plans describe what should happen.
Claims describe who is currently working where.

That combination is much more useful than either one alone.
