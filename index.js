require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    EndBehaviorType,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    StreamType
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const prism = require('prism-media');
const { WaveFile } = require('wavefile');

let transcriber = null;
(async () => {
    try {
        console.log("Loading Whisper Model...");
        const { pipeline, env } = await import('@xenova/transformers');
        env.allowLocalModels = false;
        transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        console.log("Whisper Model Loaded\n\n");
    } catch (e) {
        console.error("Failed to load whisper model:", e);
    }
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ]
});

client.on('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

const connections = new Map();

client.on('messageCreate', async message => {
    if (!message.guild) return;

    if (message.content === '!join') {
        const channel = message.member?.voice.channel;

        if (channel) {
            try {
                const connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: false,
                });

                connections.set(message.guild.id, connection);
                const reply = await message.reply('Joined voice channel!');
                setTimeout(() => reply.delete().catch(console.error), 3000);

                connection.on(VoiceConnectionStatus.Ready, () => {
                    console.log(`Connection ready in guild ${message.guild.id}`);

                    // Listen to audio from users
                    const receiver = connection.receiver;

                    // Clear any existing listeners to prevent duplicates if the bot reconnects
                    receiver.speaking.removeAllListeners('start');

                    // Keep track of active streams per userId so we can cancel overlapping ones
                    const activeStreams = new Map();

                    receiver.speaking.on('start', (userId) => {
                        const conn = connections.get(message.guild.id);
                        if (conn && conn.isSpeaking) {
                            // Ignore if the bot is currently talking
                            return;
                        }

                        // If the user takes a brief breath, Discord might fire 'start' again.
                        // We must ignore the new 'start' event and let the existing stream continue capturing the audio until silence is reached.
                        if (activeStreams.has(userId)) {
                            return;
                        }

                        console.log(`User ${userId} started speaking`);

                        // Wait for 2.5 seconds of silence (debounce) before capturing a full phrase to accommodate for breathing pauses
                        const audioStream = receiver.subscribe(userId, {
                            end: {
                                behavior: EndBehaviorType.AfterSilence,
                                duration: 2500, // Increased to 2.5 seconds
                            },
                        });

                        activeStreams.set(userId, audioStream);

                        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
                        const pcmStream = audioStream.pipe(opusDecoder);

                        let buffer = [];
                        pcmStream.on('data', chunk => {
                            buffer.push(chunk);
                        });

                        pcmStream.on('end', async () => {
                            // Remove from active streams since it finished naturally
                            activeStreams.delete(userId);

                            const finalBuffer = Buffer.concat(buffer);

                            if (finalBuffer.length < 50000) {
                                return; // Ignore very short audio clips (likely noise)
                            }

                            console.log('Audio captured. Processing for Whisper...');

                            try {
                                const ollama = require('ollama').default;

                                if (!transcriber) {
                                    console.log('Transcriber still loading, skipping audio processing...');
                                    return;
                                }

                                // Discord sends us a 48kHz, 2-channel, 16-bit PCM stream
                                // We need to convert it to a 16kHz, 1-channel, 32-bit float array for Whisper.

                                // Step 1 & 2: Convert raw Buffer (Int16, Stereo) to Float32 Mono
                                // Since it is stereo, left and right channels are interleaved: L1 R1 L2 R2 ...
                                const numFrames = finalBuffer.length / 4; // 16-bit stereo = 4 bytes per frame
                                const monoFloatData = new Float32Array(numFrames);

                                for (let i = 0; i < numFrames; i++) {
                                    // Read Left and Right 16-bit signed integers
                                    const leftInt16 = finalBuffer.readInt16LE(i * 4);
                                    const rightInt16 = finalBuffer.readInt16LE((i * 4) + 2);

                                    // Mix down to mono by averaging
                                    const monoInt16 = (leftInt16 + rightInt16) / 2;

                                    // Normalize to [-1.0, 1.0] float
                                    monoFloatData[i] = monoInt16 / 32768.0;
                                }

                                // Step 3: Resample from 48kHz to 16kHz
                                // Since 48000 % 16000 === 0, we can just take every 3rd sample for a basic downsample
                                const resampledLength = Math.floor(numFrames / 3);
                                const audioData = new Float32Array(resampledLength);

                                for (let i = 0; i < resampledLength; i++) {
                                    audioData[i] = monoFloatData[i * 3];
                                }

                                const output = await transcriber(audioData);
                                const fullText = output.text.toLowerCase().trim();

                                // Always output the transcription so we can see what the bot heard
                                if (output.text.trim()) {
                                    console.log(`\n🗣️ [USER]: ${output.text.trim()}`);
                                }

                                // Keyword detection
                                if (fullText.includes('jarvis')) {
                                    console.log(`⚙️ Generating response...`);

                                    // Extract the actual question/command
                                    const commandText = fullText.split('jarvis')[1].trim();

                                    const promptPath = path.join(__dirname, 'prompt.txt');
                                    let SYSTEM_PROMPT = '';
                                    try {
                                        const promptBase = ``;
                                        SYSTEM_PROMPT = promptBase + fs.readFileSync(promptPath, 'utf8');
                                    } catch (err) {
                                        console.error('Error reading prompt.txt:', err);
                                    }

                                    // Send to Ollama
                                    const response = await ollama.chat({
                                        model: 'llama3.1:8b',
                                        messages: [
                                            { role: "system", content: SYSTEM_PROMPT },
                                            { role: 'user', content: `Answer in 1-3 sentences max. ${commandText}` }],
                                    });

                                    let aiReply = response.message.content;
                                    console.log(`🤖 [Jarvis]: ${aiReply}\n`);

                                    // Add 'over' to the end of the spoken message
                                    //aiReply += " over.";

                                    // Text to Speech Response
                                    try {
                                        // Google TTS API can only handle ~200 characters per request
                                        // We will split the text into chunks of up to 200 characters, trying to split on spaces.
                                        const words = aiReply.split(' ');
                                        const chunks = [];
                                        let currentChunk = '';

                                        for (const word of words) {
                                            if (currentChunk.length + word.length + 1 <= 200) {
                                                currentChunk += (currentChunk.length === 0 ? '' : ' ') + word;
                                            } else {
                                                if (currentChunk.length > 0) chunks.push(currentChunk);
                                                currentChunk = word;
                                            }
                                        }
                                        if (currentChunk.length > 0) chunks.push(currentChunk);

                                        // Set speaking lock
                                        connections.get(message.guild.id).isSpeaking = true;

                                        // Play each chunk sequentially
                                        for (let i = 0; i < chunks.length; i++) {
                                            const chunkText = chunks[i];
                                            const audioUrl = googleTTS.getAudioUrl(chunkText, {
                                                lang: 'en',
                                                slow: false,
                                                host: 'https://translate.google.com',
                                            });

                                            const player = createAudioPlayer();

                                            // Use FFmpeg to speed up the audio via atempo filter
                                            const ffmpegProcess = new prism.FFmpeg({
                                                args: [
                                                    '-analyzeduration', '0',
                                                    '-loglevel', '0',
                                                    '-i', audioUrl,
                                                    '-filter:a', 'atempo=1.25', // Change this value to adjust speed (e.g., 1.5, 1.75)
                                                    '-f', 's16le',
                                                    '-ar', '48000',
                                                    '-ac', '2'
                                                ]
                                            });

                                            const resource = createAudioResource(ffmpegProcess, {
                                                inputType: StreamType.Raw
                                            });

                                            // Wrap playback in a promise so we wait for this chunk to finish
                                            await new Promise((resolve, reject) => {
                                                player.play(resource);
                                                connection.subscribe(player);

                                                player.on(AudioPlayerStatus.Playing, () => {
                                                    // Only log on the first chunk so it isn't spammy
                                                    if (i === 0) console.log('The AI audio is now playing!');
                                                });

                                                player.on(AudioPlayerStatus.Idle, () => {
                                                    resolve();
                                                });

                                                player.on('error', error => {
                                                    console.error(`Error playing chunk ${i}: ${error.message}`);
                                                    resolve(); // Resolve anyway to continue with next chunk or cleanup
                                                });
                                            });
                                        }

                                        // Release lock after all chunks finish playing
                                        console.log('Finished speaking.');
                                        connections.get(message.guild.id).isSpeaking = false;

                                    } catch (err) {
                                        console.error('TTS Error:', err);
                                        connections.get(message.guild.id).isSpeaking = false;
                                    }
                                } else {
                                    // Ignore quietly if wake word not detected
                                }
                            } catch (error) {
                                console.error('Error during AI processing:', error);
                            }
                        });
                    });
                });

                connection.on('error', (error) => {
                    console.error('Connection error:', error);
                });

            } catch (error) {
                console.error(error);
                message.reply('Failed to join voice channel!');
            }
        } else {
            message.reply('You need to join a voice channel first!');
        }
    } else if (message.content === '!leave') {
        const connection = connections.get(message.guild.id);
        if (connection) {
            connection.destroy();
            connections.delete(message.guild.id);
            const reply = await message.reply('Left voice channel!');
            setTimeout(() => reply.delete().catch(console.error), 3000);
        } else {
            const reply = await message.reply('Not currently in a voice channel!');
            setTimeout(() => reply.delete().catch(console.error), 3000);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
