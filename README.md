# OpenSaysMe
A more natural way to navigate and direct AI agents using voice, context, and gaze tracking.

## Why

Speaking to an agent can feel effortless. Finding the right
conversation, switching windows, and copying context often does not.

This project explores a simpler interaction: indicate what you mean,
say what you want, and send it to the right agent without navigating
every step yourself.

## What we're exploring

- Look at or select a terminal error:
  “Send this to the debugging agent.”
- Say: “Switch to the agent working on authentication.”
- Say: “Show me the agent waiting for my input, then take me back here.”

Voice expresses the request. Selections, pointer position, application
context, and gaze help identify the target. A hotkey or
other deliberate action initiates the interaction.

The goal is to complement the mouse and keyboard—not replace them
or build another coding agent.

## Design goals

- **User control:** Explicit activation, visible targets, and
  confirmation for consequential actions. Looking alone never
  authorizes execution.
- **Privacy:** Local processing where practical, minimal retention,
  and explicit consent for external data transfer.
- **Interoperability:** Work alongside existing agents through
  documented integrations rather than replace their interfaces.
  
