See [AGENTS.md](AGENTS.md) for Ground Control integration, development standards, and repository structure. Everything in AGENTS.md applies here.

Always use the package manager to install dependencies.
Always follow the coding standards.
Keep docs and ADRs up to date.
Always do the right thing, not the easy thing.

## Project

Pulsar is a scene-and-composition runtime for cinematic, timeline-driven
browser presentations. The core abstraction is a reusable scene module —
not a slide. Scenes carry their own timelines, assets, captions, and
metadata. Compositions are manifests that arrange scenes into full talks,
short cuts, trailers, standalone demos, or other recompositions of the
same library.

Pulsar is intentionally generic: it is presentation-runtime software, not
a specific deck. The runtime is the product.

## Build

Tech stack is not yet committed. Build commands will be documented after
the repo-layout/build-tooling ADR lands.

## Ground Control

The Ground Control project identifier for this repo is `pulsar`.

## Code Review

Don't surface nitpicks about PR titles or descriptions unless they are grossly misleading.

## Implementation

Always check your work against the requirement you are implementing to be sure you have implemented all the functionality described in the requirement.

## Answer Questions

If you are asked a question that you don't know the answer to but you have the means to find the facts, go find the facts and answer the question. You have all the tools at your disposal to answer any of these questions, so use them.
