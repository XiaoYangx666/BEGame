# Architecture and ownership

[Documentation](./README.md) · [Getting started](./getting-started.md)

BEGame organizes runtime behavior by lifetime. Ownership tells you where to attach behavior and when it should be released.

| Owner | Responsibility |
| --- | --- |
| GameManager | Start, identify and stop game instances |
| GameEngine | Own a game session's context, players and state tree |
| GameContext | Hold game-specific runtime context |
| GameState | Own a phase, its components, events and managed runners |
| GameComponent | Implement reusable behavior within a state |
| Participation | Coordinate player membership across games in one runtime |

## A game instance owns a session

A session may contain one round or many. For a card-game Addon, the engine can represent a table session while its states coordinate individual rounds and settlements. End a round by changing phases; stop the engine when the session ends according to the game's rules.

## States define resource boundaries

Use states for waiting, playing and settlement. Subscribe through the state's EventManager and schedule cancellable work through its RunnerManager. On exit, attached components, event subscriptions and managed runners are cleaned up. Arbitrary timers, external subscriptions and promises created outside those managers still need their own cleanup.

State entry can fail. The framework rolls back resources and child states created during the failed entry; world changes and external side effects need game-specific recovery.

Keep room-wide behavior on a persistent root state. Put phase-specific behavior on child states so a round transition releases it. See [room lifecycle](./room-lifecycle.md) for disconnect and empty-room policies.

## Multiple instances and membership

Each game has its own context and player manager. Global participation is the membership authority within the same Script runtime; the default policy is exclusive participation in ordinary games. Independent behavior-pack runtimes do not share that authority.

Online presence and membership are different: a disconnected player can still own a seat during a reconnection grace period. Release membership according to the game's policy, rather than treating every disconnect as an immediate leave.

## Rules, persistence and presentation

Keep authoritative match data separate from GameState and GameComponent instances. Those runtime objects own subscriptions and work; they are not a save format. Persist explicit game snapshots, and rebuild runtime objects from them on reload.

UI, entities and animations project game state. They should not become the only source of truth for scores, turns or outcomes. The [rule/runtime separation reference](./ddz-support.md) develops this pattern.

## Optional integrations

Core uses the shared Trace vocabulary, but does not depend on the Trace implementation. Inject a runtime to enable tracing; import the server entry to enable built-in server integration. Platform-specific Trace bindings remain separate from the platform-independent codec and session logic.

See [packaging](./packaging.md) for checks that enforce these boundaries, and [headless testing](./TEST_ENGINE.md) for what can be verified outside Minecraft.
