# Skill Issue 🧠

A Chrome extension that auto-reads SkillRack coding problems and types out AI-generated solutions directly into the editor.

## Features
- Scrapes problem statement from SkillRack
- Sends it to Groq API for a code solution
- Auto-types the solution into the SkillRack code editor (iframe)
- Handles code injection and submission flow

## Setup
1. Clone this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer Mode**
4. Click **Load unpacked** → select this folder
5. Add your Groq API key in the popup

## Tech
- Manifest V3 Chrome Extension
- Groq API (LLM code generation)
- Content scripts + background service worker
