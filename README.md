# Discord Phasmophobia Transcriber Bot

A Discord bot that joins voice channels, listens to users, transcribes their speech using Whisper (locally via `@xenova/transformers`), and responds as "PhasMaid" (a Phasmophobia helper) when the wake word **"bumblebee"** is spoken. The AI responses are generated locally using **Ollama** and the **llama3.1:8b** model, then played back in the voice channel using Google TTS.

## Prerequisites

Before running the bot, ensure you have the following installed:

1. [Node.js](https://nodejs.org/) (v16.9.0 or higher recommended for Discord.js v14)
2. [Ollama](https://ollama.com/) installed and running locally.

### Required Model
This project specifically uses the `llama3.1:8b` model for generating responses.
You must pull this model in Ollama before running the bot:
```bash
ollama run llama3.1:8b
```

## Setup & Installation

1. **Clone or download the repository** to your local machine.
2. **Install Node dependencies**:
   Open a terminal in the project directory and run:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the root directory of the project and add your Discord Bot Token:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   ```

## Running the Bot

1. Ensure Ollama is running in the background.
2. Start the bot by running:
   ```bash
   node index.js
   ```
3. The console will display "Loading Whisper Model..." (this might take a moment the first time as it downloads the `Xenova/whisper-tiny.en` model). Once loaded, it will log "Logged in as [BotName]!".

## Usage in Discord

- Type `!join` in any text channel while you are connected to a voice channel. The bot will join your voice channel.
- Speak naturally. The bot monitors for speech, processes the audio through Whisper, and logs the transcriptions to the console.
- Say the wake word **"bumblebee"** followed by a Phasmophobia-related question (e.g., *"Bumblebee, what evidence does a demon have?"*).
- The bot will generate a Phasmophobia-themed answer using `llama3.1:8b`, chunk the text, and read it out loud in the voice channel.
- Type `!leave` to make the bot disconnect from the voice channel.
