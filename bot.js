require('dotenv').config();
const {
  Client, GatewayIntentBits, Collection, ActivityType,
  REST, Routes, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
  StreamType,
} = require('@discordjs/voice');
const youtubedl = require('youtube-dl-exec');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
// ─────────────────────────────────────────────────────────────────────────────
//  SAFETY CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const SAFETY = {
  MAX_AGE_LIMIT: 18,
  BLOCKED_CATEGORIES: [
    'nsfw', 'adult', 'porn', 'pornography', 'xxx', 'explicit',
    'hentai', 'erotic', 'sex', 'nude', 'naked', 'sus',
  ],
  BLOCKED_KEYWORDS: [
    'nsfw', 'porn', 'pornography', 'xxx', 'hentai', 'erotic',
    'onlyfans', 'nude', 'naked', 'explicit content', 'sus',
  ],
  MAX_DURATION: 10800, // 3 hours max, set to 0 to disable
  MIN_DURATION: 3,     // block clips under 3 seconds
};

const AD_URL    = 'https://youtu.be/9dLq93BbWhQ?si=85sYEIPEy5QQy6Xs';
const AD_CHANCE = 0.1;

function safetyCheck(info) {
  if (!info) return { blocked: false };

  if (info.age_limit && info.age_limit >= SAFETY.MAX_AGE_LIMIT)
    return { blocked: true, reason: `🔞 Age-restricted content (${info.age_limit}+) is not allowed.` };

  if (info.is_nsfw === true)
    return { blocked: true, reason: '🚫 NSFW content is not allowed.' };

  const cats = [...(info.categories || []), ...(info.tags || [])].map(c => c.toLowerCase());
  for (const blocked of SAFETY.BLOCKED_CATEGORIES)
    if (cats.some(c => c.includes(blocked)))
      return { blocked: true, reason: `🚫 Blocked category: \`${blocked}\`` };

  const titleLower = (info.title || '').toLowerCase();
  const descLower  = (info.description || '').toLowerCase();
  for (const kw of SAFETY.BLOCKED_KEYWORDS)
    if (titleLower.includes(kw) || descLower.includes(kw))
      return { blocked: true, reason: '🚫 Blocked keyword detected in video metadata.' };

  const dur = info.duration || 0;
  if (SAFETY.MAX_DURATION > 0 && dur > SAFETY.MAX_DURATION)
    return { blocked: true, reason: `⏱ Video too long. Max is ${Math.floor(SAFETY.MAX_DURATION/3600)}h.` };
  if (dur > 0 && dur < SAFETY.MIN_DURATION)
    return { blocked: true, reason: '⏱ Video is too short to be valid.' };

  return { blocked: false };
}


// ── Express / Dashboard deps ──────────────────────────────────────────────────
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios   = require('axios');

const app  = express();
const PORT = 5000;
const DASHBOARD_URL = 'https://dash.aqmusic.app';
const DISCORD_API   = 'https://discord.com/api/v10';

// In-memory stores (per-user history & liked songs)
const userStore = new Map();
function getUser(id) {
  if (!userStore.has(id)) userStore.set(id, { history: [], liked: [] });
  return userStore.get(id);
}

// ─────────────────────────────────────────────────────────────────────────────
//  COLORS & EMBEDS
// ─────────────────────────────────────────────────────────────────────────────
const C = { gold: 0xf5a623, green: 0x43b581, red: 0xf04747, dark: 0x2f3136, blurple: 0x5865f2 };
const base   = (color = C.gold) => new EmbedBuilder().setColor(color).setFooter({ text: 'AudioQuack - Best way to Quack your Music' });
const simple = (desc, color = C.blurple) => base(color).setDescription(desc);

function fmtSecs(secs) {
  if (!secs) return '0:00';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60), h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function embedNowPlaying(track, queue) {
  const e = base(C.gold)
    .setAuthor({ name: '🦆  Now Playing' })
    .setTitle(track.title.length > 60 ? track.title.slice(0,57)+'...' : track.title)
    .setURL(track.url)
    .addFields(
      { name: '🎤 Artist',   value: track.author || 'Unknown', inline: true },
      { name: '⏱ Duration', value: fmtSecs(track.duration),   inline: true },
      { name: '🔢 In Queue', value: `${queue.tracks.length} track${queue.tracks.length !== 1 ? 's' : ''}`, inline: true },
      { name: '\u200b', value: `\`${'─'.repeat(16)}\`\n\`0:00 / ${fmtSecs(track.duration)}\`` },
    ).setTimestamp();
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  return e;
}

function embedTrackAdded(track, pos) {
  const e = base(C.green)
    .setAuthor({ name: '🎵  Added to Queue' })
    .setTitle(track.title.length > 60 ? track.title.slice(0,57)+'...' : track.title)
    .setURL(track.url)
    .addFields(
      { name: '🎤 Artist',   value: track.author || 'Unknown', inline: true },
      { name: '⏱ Duration', value: fmtSecs(track.duration),   inline: true },
      { name: '📍 Position', value: `#${pos}`,                 inline: true },
    );
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  return e;
}

function embedQueue(queue, page = 0) {
  const perPage = 10, pages = Math.max(1, Math.ceil(queue.tracks.length / perPage));
  const lines = queue.tracks
    .slice(page * perPage, (page + 1) * perPage)
    .map((t, i) => `\`${page * perPage + i + 1}.\` **${t.title.slice(0,45)}** — ${t.author} \`${fmtSecs(t.duration)}\``);
  const embed = base(C.gold)
    .setAuthor({ name: `🎵  Queue  •  Page ${page + 1}/${pages}` })
    .setDescription(lines.join('\n') || '*Queue is empty.*')
    .setFooter({ text: `${queue.tracks.length} track${queue.tracks.length !== 1 ? 's' : ''} in queue  •  AudioQuack` });
  if (queue.current) embed.addFields({
    name: '🦆  Now Playing',
    value: `**${queue.current.title.slice(0,60)}** — ${queue.current.author} \`${fmtSecs(queue.current.duration)}\``,
  });
  return embed;
}

// ─────────────────────────────────────────────────────────────────────────────
//  YT-DLP HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const baseFlags = () => {
  const f = { noWarnings: true, skipDownload: true, dumpSingleJson: true };
  if (fs.existsSync(COOKIES_PATH)) f.cookies = COOKIES_PATH;
  return f;
};

async function searchTracks(query, limit = 5) {
  try {
    const isUrl = /^https?:\/\//i.test(query);
    // Fetch extra results so we have room to filter out blocked ones
    const result = await youtubedl(isUrl ? query : `ytsearch${limit * 2}:${query}`, {
      ...baseFlags(), flatPlaylist: true,
    });

    if (result.id && !result.entries) {
      const check = safetyCheck(result);
      if (check.blocked) return [];  // single video blocked — return nothing
      return [{
        title: result.title || 'Unknown', author: result.uploader || result.channel || 'Unknown',
        duration: result.duration || 0, url: result.webpage_url || result.url || query,
        thumbnail: result.thumbnail || '', isVideo: true,
      }];
    }

    return (result.entries || [])
      .filter(v => !safetyCheck(v).blocked)   // drop any blocked entries
      .slice(0, limit)
      .map(v => ({
        title: v.title || 'Unknown', author: v.uploader || v.channel || 'Unknown',
        duration: v.duration || 0, url: v.url || v.webpage_url || `https://www.youtube.com/watch?v=${v.id}`,
        thumbnail: v.thumbnail || '', isVideo: true,
      }));
  } catch (err) { console.error('Search error:', err.message); return []; }
}
async function getStreamUrl(trackUrl) {
  const result = await youtubedl(trackUrl, {
    ...baseFlags(),
    format: 'bestaudio/best',
  });

  // Re-run safety check at stream time (catches URLs added directly)
  const check = safetyCheck(result);
  if (check.blocked) throw new Error(`BLOCKED:${check.reason}`);

  const fmt = (result.formats || [])
    .filter(f => f.acodec !== 'none' && f.url)
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  return fmt?.url || result.url;
}

function createResource(streamUrl, volume = 0.8) {
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', streamUrl, '-vn', '-af', `volume=${volume}`, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  resource._ffmpeg = ffmpeg;
  return resource;
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOICE CHANNEL STATUS
// ─────────────────────────────────────────────────────────────────────────────
async function setVCStatus(voiceChannel, status) {
  try { await voiceChannel.client.rest.put(`/channels/${voiceChannel.id}/voice-status`, { body: { status } }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  DJ ROLE SYSTEM (persisted to djroles.json)
// ─────────────────────────────────────────────────────────────────────────────
const DJ_ROLES_PATH = path.join(__dirname, 'djroles.json');
const djRoles = new Map();

if (fs.existsSync(DJ_ROLES_PATH)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DJ_ROLES_PATH, 'utf8'));
    for (const [guildId, roleId] of Object.entries(saved)) djRoles.set(guildId, roleId);
    console.log('✅ DJ roles loaded');
  } catch { console.error('❌ Failed to load djroles.json'); }
}

function saveDJRoles() {
  fs.writeFileSync(DJ_ROLES_PATH, JSON.stringify(Object.fromEntries(djRoles)), 'utf8');
}

function isDJ(interaction) {
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const djRoleId = djRoles.get(interaction.guild.id);
  return !djRoleId || interaction.member.roles.cache.has(djRoleId);
}
function djOnly(interaction) {
  if (isDJ(interaction)) return true;
  interaction.reply({ embeds: [simple('❌ You need the **DJ role** to use this command!', C.red)], ephemeral: true });
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  QUEUE MANAGER
// ─────────────────────────────────────────────────────────────────────────────
const queues = new Map();

class GuildQueue {
  constructor(guildId, voiceChannel, textChannel) {
    this.guildId      = guildId;
    this.voiceChannel = voiceChannel;
    this.textChannel  = textChannel;
    this.tracks       = [];
    this.current      = null;
    this.volume       = 0.8;
    this.loop         = 'off';
    this.loading      = false;
    this.player       = createAudioPlayer();
    this.connection   = null;
    this._res         = null;
    this._destroyed   = false;
    this._requesterId = null;
    this._setupPlayer();
  }

  _setupPlayer() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this._destroyed) return;
      this._killFfmpeg();
      if (this.loop === 'track' && this.current) return this._play(this.current, this._requesterId);
      if (this.loop === 'queue' && this.current && !this.current.isAd) this.tracks.push({ ...this.current, requesterId: this._requesterId });
      this.current = null;
      this._requesterId = null;
      this._next();
    });
    this.player.on('error', err => {
      if (this._destroyed) return;
      console.error('Player error:', err.message);
      this._killFfmpeg();
      this.textChannel.send({ embeds: [simple(`❌ Playback error: \`${err.message?.slice(0,200)}\``, C.red)] });
      this.current = null;
      this.loading = false;
      this._next();
    });
  }

  _killFfmpeg() {
    try { this._res?._ffmpeg?.kill('SIGKILL'); } catch {}
    this._res = null;
  }

  async connect() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    this.connection.subscribe(this.player);
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      this.connection.destroy();
      queues.delete(this.guildId);
      throw new Error('Could not connect to voice channel.');
    }
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.tracks = [];
        this.current = null;
        this.loading = false;
        this._killFfmpeg();
        setVCStatus(this.voiceChannel, '');
        try { this.player.stop(true); } catch {}

        try {
          this.connection = joinVoiceChannel({
            channelId: this.voiceChannel.id,
            guildId: this.guildId,
            adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
          });
          this.connection.subscribe(this.player);
          await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
          this._destroyed = false;
          this.textChannel.send({ embeds: [simple('🔄 Reconnected! Queue has been cleared.', C.gold)] });
        } catch {
          this.destroy();
          this.textChannel.send({ embeds: [simple('❌ Could not reconnect to voice channel.', C.red)] });
        }
      }
    });
  }

  addTrack(track, requesterId) { this.tracks.push({ ...track, requesterId }); }
  async start() { if (!this.current && !this.loading) this._next(); }

 async _play(track, requesterId) {
    if (this._destroyed) return;
    this.loading = true;
    try {
      const streamUrl = await getStreamUrl(track.url);
      if (!streamUrl) throw new Error('yt-dlp returned no stream URL');
      if (this._destroyed) return;
      const res = createResource(streamUrl, this.volume);
      this._res = res;
      this.current = track;
      this._requesterId = requesterId;
      this.loading = false;
      this.player.play(res);
      if (!track.isAd) {
        setVCStatus(this.voiceChannel, `<:playyellow:1492154504722780230> ${track.title}`);
        this.textChannel.send({ embeds: [embedNowPlaying(track, this)] });
        if (requesterId) {
          const u = getUser(requesterId);
          u.history = [track, ...u.history.filter(t => t.url !== track.url)].slice(0, 50);
        }
      } else {
        this.textChannel.send({ embeds: [simple('📢 Ad Break!', C.gold)] });
      }
    } catch (err) {
      if (this._destroyed) return;
      console.error('Stream error:', err.message);
      const isBlocked = err.message?.startsWith('BLOCKED:');
      const msg = isBlocked
        ? err.message.replace('BLOCKED:', '')
        : `❌ Could not stream **${track.title}**`;
      this.textChannel.send({ embeds: [simple(msg, C.red)] });
      this.current = null;
      this.loading = false;
      this._next();
    }
  }

  async _next() {
    if (this._destroyed) return;
    if (!this.tracks.length) {
      setVCStatus(this.voiceChannel, '');
      this.textChannel.send({ embeds: [simple('✅ Queue finished. Use **/play** to add more!', C.dark)] });
      setTimeout(() => { if (!this._destroyed && !this.isActive()) this.destroy(); }, 30_000);
      return;
    }
    const next = this.tracks.shift();

    if (Math.random() < AD_CHANCE) {
      const adTrack = {
        title: '🦆 AudioQuack Ad',
        author: 'AudioQuack',
        duration: 0,
        url: AD_URL,
        thumbnail: '',
        isAd: true,
      };
      this.tracks.unshift(next);
      return this._play(adTrack, null);
    }

    this._play(next, next.requesterId);
  }

  isActive()  { return !!(this.current || this.loading || this.tracks.length); }
  isPlaying() { return this.player.state.status !== AudioPlayerStatus.Idle || this.loading; }
  isPaused()  { return this.player.state.status === AudioPlayerStatus.Paused; }
  setVolume(vol) { this.volume = vol / 100; }
  skip()  { this._killFfmpeg(); this.player.stop(true); }
  pause() { this.player.pause(); }
  resume(){ this.player.unpause(); }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    setVCStatus(this.voiceChannel, '');
    this.tracks = []; this.current = null; this.loading = false;
    this._killFfmpeg();
    try { this.player.stop(true); } catch {}
    try { this.connection?.destroy(); } catch {}
    queues.delete(this.guildId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

// ─────────────────────────────────────────────────────────────────────────────
//  SLASH COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('dj').setDescription('🎧 Manage the DJ role')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('set').setDescription('Set the DJ role').addRoleOption(o => o.setName('role').setDescription('The DJ role').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove the DJ role restriction'))
      .addSubcommand(s => s.setName('show').setDescription('Show the current DJ role')),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      if (sub === 'set') {
        const role = interaction.options.getRole('role', true);
        djRoles.set(interaction.guild.id, role.id);
        saveDJRoles();
        return interaction.reply({ embeds: [simple(`✅ DJ role set to ${role}!`, C.green)] });
      }
      if (sub === 'remove') {
        djRoles.delete(interaction.guild.id);
        saveDJRoles();
        return interaction.reply({ embeds: [simple('✅ DJ role removed.', C.green)] });
      }
      const djRoleId = djRoles.get(interaction.guild.id);
      if (!djRoleId) return interaction.reply({ embeds: [simple('ℹ️ No DJ role set.', C.blurple)] });
      const role = interaction.guild.roles.cache.get(djRoleId);
      return interaction.reply({ embeds: [simple(`🎧 Current DJ role: ${role ?? 'Unknown (deleted?)'}`, C.gold)] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('play').setDescription('🎵 Plays a Song via AQ')
      .addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setRequired(true).setAutocomplete(true)),
    async autocomplete(interaction) {
      const query = interaction.options.getFocused();
      if (!query || query.length < 2) return interaction.respond([]);
      try {
        const results = await searchTracks(query, 8);
        await interaction.respond(results.slice(0,25).map(t => ({
          name: `${t.title.slice(0,50)} — ${t.author} [${fmtSecs(t.duration)}]`.slice(0,100),
          value: t.url,
        })));
      } catch { await interaction.respond([]); }
    },
    async execute(interaction) {
      await interaction.deferReply();
      const vc = interaction.member?.voice?.channel;
      if (!vc) return interaction.editReply({ embeds: [simple('❌ Join a voice channel first!', C.red)] });
      const query = interaction.options.getString('query', true);
      const results = await searchTracks(query, 1);
      if (!results.length) return interaction.editReply({ embeds: [simple(`❌ No results for **${query}**`, C.red)] });
      const found = results[0];
      let queue = queues.get(interaction.guild.id);
      if (!queue) {
        queue = new GuildQueue(interaction.guild.id, vc, interaction.channel);
        queues.set(interaction.guild.id, queue);
        try { await queue.connect(); }
        catch { queues.delete(interaction.guild.id); return interaction.editReply({ embeds: [simple('❌ Could not join your voice channel!', C.red)] }); }
      }
      queue.addTrack(found, interaction.user.id);
      if (!queue.isActive() || (!queue.current && !queue.loading)) await queue.start();
      const isFirst = queue.tracks.length === 0 && (queue.current?.url === found.url || queue.loading);
      await interaction.editReply({
        embeds: [isFirst ? simple(`🔍 Loading **${found.title}**…`, C.blurple) : embedTrackAdded(found, queue.tracks.length)],
      });
    },
  },

  {
    data: new SlashCommandBuilder().setName('skip').setDescription('⏭ Skip the current track'),
    async execute(interaction) {
      const queue = queues.get(interaction.guild.id);
      if (!queue?.isActive()) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      queue.skip();
      await interaction.reply({ embeds: [simple('⏭ Skipped!', C.green)] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('pause').setDescription('⏸ Pause playback'),
    async execute(interaction) {
      const queue = queues.get(interaction.guild.id);
      if (!queue?.isActive()) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      if (queue.isPaused()) return interaction.reply({ embeds: [simple('⚠️ Already paused.', C.dark)], ephemeral: true });
      queue.pause();
      await interaction.reply({ embeds: [simple('⏸ Paused.', C.blurple)] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('resume').setDescription('▶️ Resume playback'),
    async execute(interaction) {
      const queue = queues.get(interaction.guild.id);
      if (!queue?.isActive()) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      if (!queue.isPaused()) return interaction.reply({ embeds: [simple('⚠️ Not paused.', C.dark)], ephemeral: true });
      queue.resume();
      await interaction.reply({ embeds: [simple('▶️ Resumed!', C.green)] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('stop').setDescription('⏹ Stop and clear queue'),
    async execute(interaction) {
      if (!djOnly(interaction)) return;
      const queue = queues.get(interaction.guild.id);
      if (!queue) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      queue.destroy();
      await interaction.reply({ embeds: [simple('⏹ Stopped and cleared the queue.', C.dark)] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('volume').setDescription('🔊 Set the volume')
      .addIntegerOption(o => o.setName('level').setDescription('0–150').setRequired(true).setMinValue(0).setMaxValue(150)),
    async execute(interaction) {
      if (!djOnly(interaction)) return;
      const queue = queues.get(interaction.guild.id);
      if (!queue) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      const level = interaction.options.getInteger('level', true);
      queue.setVolume(level);
      const bar = '█'.repeat(Math.round(level/10)) + '░'.repeat(15 - Math.round(level/10));
      const emoji = level === 0 ? '🔇' : level < 50 ? '🔉' : '🔊';
      await interaction.reply({ embeds: [simple(`${emoji} Volume → **${level}%**\n\`${bar}\``, C.blurple)] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('🎵 Show current track'),
    async execute(interaction) {
      const queue = queues.get(interaction.guild.id);
      if (!queue?.current) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      await interaction.reply({ embeds: [embedNowPlaying(queue.current, queue)] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('queue').setDescription('📋 View the queue')
      .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)),
    async execute(interaction) {
      const queue = queues.get(interaction.guild.id);
      if (!queue?.isActive()) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      const perPage = 10, total = Math.max(1, Math.ceil(queue.tracks.length / perPage));
      let page = Math.min((interaction.options.getInteger('page') ?? 1) - 1, total - 1);
      const buildRow = p => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`q_prev_${p}`).setLabel('â—€ Prev').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
        new ButtonBuilder().setCustomId(`q_next_${p}`).setLabel('Next â–¶').setStyle(ButtonStyle.Secondary).setDisabled(p >= total - 1),
      );
      const reply = await interaction.reply({ embeds: [embedQueue(queue, page)], components: total > 1 ? [buildRow(page)] : [], fetchReply: true });
      if (total <= 1) return;
      const col = reply.createMessageComponentCollector({ time: 60_000 });
      col.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'Not your queue view.', ephemeral: true });
        btn.customId.startsWith('q_prev') ? page-- : page++;
        page = Math.max(0, Math.min(page, total - 1));
        await btn.update({ embeds: [embedQueue(queue, page)], components: [buildRow(page)] });
      });
      col.on('end', () => reply.edit({ components: [] }).catch(() => {}));
    },
  },

  {
    data: new SlashCommandBuilder().setName('shuffle').setDescription('🔀 Shuffle the queue'),
    async execute(interaction) {
      if (!djOnly(interaction)) return;
      const queue = queues.get(interaction.guild.id);
      if (!queue || queue.tracks.length < 2) return interaction.reply({ embeds: [simple('⚠️ Need 2+ tracks to shuffle.', C.dark)], ephemeral: true });
      for (let i = queue.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
      }
      await interaction.reply({ embeds: [simple(`🔀 Shuffled **${queue.tracks.length}** tracks!`, C.green)] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('loop').setDescription('🔁 Set loop mode')
      .addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true)
        .addChoices({ name: '🚫 Off', value: 'off' }, { name: '🔂 Track', value: 'track' }, { name: '🔁 Queue', value: 'queue' })),
    async execute(interaction) {
      if (!djOnly(interaction)) return;
      const queue = queues.get(interaction.guild.id);
      if (!queue) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      const m = interaction.options.getString('mode', true);
      queue.loop = m;
      const label = { off: '🚫 Loop **disabled**', track: '🔂 Looping **current track**', queue: '🔂 Looping **entire queue**' };
      await interaction.reply({ embeds: [simple(label[m], C.blurple)] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('remove').setDescription('🗑 Remove a track')
      .addIntegerOption(o => o.setName('position').setDescription('Queue position').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      if (!djOnly(interaction)) return;
      const queue = queues.get(interaction.guild.id);
      if (!queue) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
      const pos = interaction.options.getInteger('position', true) - 1;
      if (pos >= queue.tracks.length) return interaction.reply({ embeds: [simple(`❌ Position **${pos+1}** out of range.`, C.red)], ephemeral: true });
      const [removed] = queue.tracks.splice(pos, 1);
      await interaction.reply({ embeds: [simple(`🗑 Removed **${removed.title}**`, C.green)] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('disconnect').setDescription('👋 Disconnect from voice'),
    async execute(interaction) {
      if (!djOnly(interaction)) return;
      const queue = queues.get(interaction.guild.id);
      const botInVC = interaction.guild.members.me?.voice?.channel;
      if (!queue && !botInVC) return interaction.reply({ embeds: [simple("❌ I'm not in a voice channel!", C.red)], ephemeral: true });
      if (queue) queue.destroy();
      if (!queue && botInVC) try { interaction.guild.members.me.voice.disconnect(); } catch {}
      await interaction.reply({ embeds: [simple('👋 Disconnected. See you next time!', C.dark)] });
    },
  },   
  {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('⏩ Seek to a position in the current track')
    .addIntegerOption(o => o.setName('seconds').setDescription('Position in seconds').setRequired(true).setMinValue(0)),
  async execute(interaction) {
    const queue = queues.get(interaction.guild.id);
    if (!queue?.current) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
    const secs = interaction.options.getInteger('seconds', true);
    if (queue.current.duration > 0 && secs >= queue.current.duration)
      return interaction.reply({ embeds: [simple(`❌ Track is only **${fmtSecs(queue.current.duration)}** long.`, C.red)], ephemeral: true });
    await interaction.deferReply();
    try {
      const streamUrl = await getStreamUrl(queue.current.url);
      queue._killFfmpeg();
      const ffmpeg = spawn('ffmpeg', [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-ss', String(secs),
        '-i', streamUrl, '-vn', '-af', `volume=${queue.volume}`, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
      resource._ffmpeg = ffmpeg;
      queue._res = resource;
      queue.player.play(resource);
      await interaction.editReply({ embeds: [simple(`⏩ Seeked to **${fmtSecs(secs)}**`, C.blurple)] });
    } catch (err) {
      console.error('Seek error:', err.message);
      await interaction.editReply({ embeds: [simple('❌ Failed to seek.', C.red)] });
    }
  },
},
    {
  data: new SlashCommandBuilder()
    .setName('clearqueue')
    .setDescription('🗑 Clear the queue without stopping current track'),
  async execute(interaction) {
    if (!djOnly(interaction)) return;
    const queue = queues.get(interaction.guild.id);
    if (!queue) return interaction.reply({ embeds: [simple('❌ Nothing is playing!', C.red)], ephemeral: true });
    const count = queue.tracks.length;
    if (!count) return interaction.reply({ embeds: [simple('⚠️ Queue is already empty.', C.dark)], ephemeral: true });
    queue.tracks = [];
    await interaction.reply({ embeds: [simple(`🗑 Cleared **${count}** track${count !== 1 ? 's' : ''} from the queue.`, C.green)] });
  },
},
    {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('↕️ Move a track to a different position')
    .addIntegerOption(o => o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
    .addIntegerOption(o => o.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    if (!djOnly(interaction)) return;
    const queue = queues.get(interaction.guild.id);
    if (!queue || !queue.tracks.length) return interaction.reply({ embeds: [simple('❌ Queue is empty!', C.red)], ephemeral: true });
    const from = interaction.options.getInteger('from', true) - 1;
    const to   = interaction.options.getInteger('to',   true) - 1;
    const len  = queue.tracks.length;
    if (from >= len) return interaction.reply({ embeds: [simple(`❌ Position **${from+1}** out of range.`, C.red)], ephemeral: true });
    if (to   >= len) return interaction.reply({ embeds: [simple(`❌ Position **${to+1}** out of range.`, C.red)], ephemeral: true });
    if (from === to) return interaction.reply({ embeds: [simple('⚠️ Already in that position.', C.dark)], ephemeral: true });
    const [track] = queue.tracks.splice(from, 1);
    queue.tracks.splice(to, 0, track);
    await interaction.reply({ embeds: [simple(`↕️ Moved **${track.title.slice(0,50)}** from #${from+1} to #${to+1}`, C.green)] });
  },
},
];

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED HTML SHELL
// ─────────────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const FAVICON = `<link rel="icon" href="https://tr.rbxcdn.com/180DAY-cc9582e1a3a2740ac96ea118f56c24cf/420/420/ShoulderAccessory/Webp/noFilter">`;

const GLOBAL_CSS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0a0a0c;
  --sidebar-bg: #0f0f12;
  --surface: #16161a;
  --surface2: #1e1e24;
  --border: #ffffff0f;
  --border2: #ffffff18;
  --gold: #f5a623;
  --gold-dim: #f5a62330;
  --gold-mid: #f5a62360;
  --green: #22c55e;
  --red: #ef4444;
  --blurple: #5865f2;
  --text: #f0f0f5;
  --muted: #6b6b7a;
  --muted2: #9898a8;
}
*{box-sizing:border-box;margin:0;padding:0}
html{height:100%}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;height:100%;overflow:hidden}
.app-body{display:flex;flex:1;min-height:0}
.main{flex:1;overflow-y:auto;min-height:0;padding:28px 32px;display:flex;flex-direction:column;gap:24px}
a{color:var(--gold);text-decoration:none}
a:hover{opacity:.8}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}

/* ── TOPBAR ── */
.topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:0 24px;height:56px;flex-shrink:0;
  background:var(--sidebar-bg);
  border-bottom:1px solid var(--border);
  position:relative;z-index:10;
}
.topbar-logo{
  font-family:'Syne',sans-serif;font-weight:800;font-size:1.25rem;
  color:var(--gold);display:flex;align-items:center;gap:8px;letter-spacing:-.02em;
}
.topbar-logo span{font-size:1.4rem}
.topbar-right{display:flex;align-items:center;gap:16px}
.user-chip{display:flex;align-items:center;gap:8px;padding:5px 12px 5px 5px;background:var(--surface);border:1px solid var(--border);border-radius:999px;font-size:.82rem;font-weight:500;color:var(--muted2)}
.user-chip img{width:26px;height:26px;border-radius:50%;object-fit:cover}
.logout-btn{font-size:.8rem;color:var(--muted);padding:6px 12px;border:1px solid var(--border);border-radius:6px;transition:all .2s}
.logout-btn:hover{color:var(--text);border-color:var(--border2);opacity:1}

/* ── LAYOUT ── */


/* ── SIDEBAR ── */
.sidebar{
  width:220px;flex-shrink:0;
  background:var(--sidebar-bg);
  border-right:1px solid var(--border);
  display:flex;flex-direction:column;
  padding:20px 12px;gap:2px;
  overflow-y:auto;
}
.sidebar-section{font-family:'Syne',sans-serif;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:12px 10px 6px;margin-top:8px}
.sidebar-section:first-child{margin-top:0}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;
  font-size:.875rem;font-weight:500;color:var(--muted2);cursor:pointer;
  text-decoration:none;transition:all .15s;border:1px solid transparent;
}
.nav-item:hover{background:var(--surface);color:var(--text);opacity:1}
.nav-item.active{background:var(--gold-dim);color:var(--gold);border-color:var(--gold-mid)}
.nav-item .icon{width:16px;text-align:center;font-size:1rem;flex-shrink:0}
.sidebar-divider{height:1px;background:var(--border);margin:10px 0}

/* ── MAIN ── */


/* ── CARDS ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;}
.card-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.card-title{font-family:'Syne',sans-serif;font-weight:700;font-size:.9rem;letter-spacing:.02em;color:var(--text)}
.card-body{padding:20px}

/* ── NOW PLAYING ── */
.np-card{background:linear-gradient(135deg,#1a1200 0%,var(--surface) 60%);border:1px solid var(--gold-mid)}
.np-inner{display:flex;align-items:center;gap:20px;padding:20px}
.np-thumb{width:88px;height:88px;border-radius:10px;object-fit:cover;background:var(--surface2);flex-shrink:0;box-shadow:0 8px 24px #0008}
.np-thumb-placeholder{width:88px;height:88px;border-radius:10px;background:var(--surface2);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:2rem}
.np-info{flex:1;min-width:0}
.np-label{font-size:.7rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:4px}
.np-title{font-family:'Syne',sans-serif;font-weight:700;font-size:1.05rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.np-author{font-size:.82rem;color:var(--muted2);margin-top:3px}
.np-meta{display:flex;align-items:center;gap:8px;margin-top:8px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:.72rem;font-weight:600}
.pill-gold{background:var(--gold-dim);color:var(--gold);border:1px solid var(--gold-mid)}
.pill-muted{background:var(--surface2);color:var(--muted2);border:1px solid var(--border)}
.controls{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}
.ctrl-btn{
  display:inline-flex;align-items:center;gap:6px;padding:7px 14px;
  border-radius:8px;border:none;cursor:pointer;font-size:.8rem;font-weight:600;
  font-family:'DM Sans',sans-serif;transition:all .15s;
}
.ctrl-btn:hover{opacity:.8;transform:translateY(-1px)}
.btn-gold{background:var(--gold);color:#000}
.btn-red{background:#ef444422;color:var(--red);border:1px solid #ef444433}
.btn-red:hover{background:var(--red);color:#fff}
.btn-surface{background:var(--surface2);color:var(--muted2);border:1px solid var(--border)}
.btn-surface:hover{color:var(--text);border-color:var(--border2)}
.vol-row{display:flex;align-items:center;gap:10px;margin-top:12px}
.vol-row span{font-size:.75rem;color:var(--muted);min-width:36px}
input[type=range]{accent-color:var(--gold);width:110px;cursor:pointer}

/* ── QUEUE LIST ── */
.q-list{list-style:none}
.q-item{display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--border);transition:background .15s}
.q-item:last-child{border-bottom:none}
.q-item:hover{background:var(--surface2)}
.q-num{color:var(--muted);font-size:.75rem;width:22px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums}
.q-thumb{width:44px;height:25px;object-fit:cover;border-radius:4px;background:var(--surface2);flex-shrink:0}
.q-meta{flex:1;min-width:0}
.q-title{font-size:.83rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.q-sub{font-size:.72rem;color:var(--muted);margin-top:2px}
.q-remove{background:none;border:none;color:var(--muted);cursor:pointer;font-size:.85rem;padding:4px 6px;border-radius:4px;transition:all .15s}
.q-remove:hover{background:#ef444422;color:var(--red)}

/* ── SEARCH / RESULTS ── */
.search-wrap{display:flex;gap:8px}
.search-input{
  flex:1;padding:10px 16px;background:var(--surface2);border:1px solid var(--border);
  border-radius:10px;color:var(--text);font-size:.9rem;font-family:'DM Sans',sans-serif;
  transition:border-color .2s;
}
.search-input:focus{outline:none;border-color:var(--gold)}
.search-input::placeholder{color:var(--muted)}
.results-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-top:16px}
.r-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;transition:all .2s}
.r-card:hover{border-color:var(--gold-mid);transform:translateY(-2px);box-shadow:0 8px 24px #f5a62315}
.r-thumb{width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--bg)}
.r-info{padding:10px}
.r-title{font-size:.78rem;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:4px}
.r-author{font-size:.7rem;color:var(--muted)}
.r-dur{font-size:.7rem;color:var(--gold);margin-top:3px}
.r-actions{display:flex;gap:4px;padding:0 10px 10px}
.r-actions button{flex:1;padding:5px;border-radius:6px;border:none;cursor:pointer;font-size:.72rem;font-weight:600;font-family:'DM Sans',sans-serif;transition:all .15s}
.r-actions button:first-child{background:var(--gold);color:#000}
.r-actions button:last-child{background:var(--surface);color:var(--muted2);border:1px solid var(--border)}
.r-actions button:hover{opacity:.8}

/* ── YT PLAYER ── */
.yt-wrap{display:flex;gap:8px;margin-bottom:12px}
.yt-frame{width:100%;aspect-ratio:16/9;border:none;border-radius:10px;background:#000}

/* ── GUILD GRID ── */
.guild-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
.guild-card{
  background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:20px 16px;text-align:center;text-decoration:none;color:var(--text);
  transition:all .2s;display:block;
}
.guild-card:hover{border-color:var(--gold-mid);background:var(--surface2);transform:translateY(-2px);box-shadow:0 8px 24px #f5a62310;opacity:1}
.guild-icon{width:56px;height:56px;border-radius:50%;margin:0 auto 12px;object-fit:cover;background:var(--surface2);display:block}
.guild-name{font-family:'Syne',sans-serif;font-weight:700;font-size:.85rem;line-height:1.3}
.guild-status{margin-top:6px}

/* ── HISTORY / LIKED GRID ── */
.track-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.t-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;transition:all .2s}
.t-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.t-thumb{width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--surface2)}
.t-info{padding:10px}
.t-title{font-size:.8rem;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:4px;line-height:1.3}
.t-author{font-size:.72rem;color:var(--muted)}
.t-dur{font-size:.72rem;color:var(--gold);margin-top:3px}
.t-actions{display:flex;gap:4px;padding:0 10px 10px;flex-direction:column}
.t-actions a,.t-actions button{display:block;width:100%;padding:5px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--muted2);cursor:pointer;font-size:.72rem;font-weight:600;font-family:'DM Sans',sans-serif;text-align:center;transition:all .15s}
.t-actions a:hover,.t-actions button:hover{border-color:var(--border2);color:var(--text);opacity:1}
.t-actions button.unlike-btn:hover{background:#ef444422;color:var(--red);border-color:#ef444433}

/* ── PAGE HEADER ── */
.page-header{display:flex;flex-direction:column;gap:4px}
.page-title{font-family:'Syne',sans-serif;font-weight:800;font-size:1.6rem;letter-spacing:-.03em}
.page-sub{font-size:.85rem;color:var(--muted)}

/* ── LOOP SELECT ── */
select{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:7px;font-size:.8rem;font-family:'DM Sans',sans-serif;cursor:pointer}
select:focus{outline:none;border-color:var(--gold)}

/* ── EMPTY ── */
.empty{text-align:center;color:var(--muted);padding:40px 20px;font-size:.9rem}

/* ── LOGIN ── */
.login-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;text-align:center;padding:20px}
.login-duck{font-size:5rem;animation:bob 2s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.login-title{font-family:'Syne',sans-serif;font-weight:800;font-size:2.4rem;color:var(--gold);letter-spacing:-.04em}
.login-sub{color:var(--muted);max-width:340px;line-height:1.6;font-size:.9rem}
.login-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 28px;background:var(--blurple);color:#fff;border-radius:10px;font-weight:600;font-size:.95rem;font-family:'Syne',sans-serif;transition:all .2s;margin-top:4px}
.login-btn:hover{opacity:.85;transform:translateY(-2px);box-shadow:0 8px 24px #5865f240;color:#fff}

/* ── SCROLLABLE COLS ── */
.two-col{display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start}
@media(max-width:900px){.two-col{grid-template-columns:1fr}.sidebar{display:none}}
</style>
`;

function shell(title, body, user = null, activePage = '') {
  const navItem = (href, icon, label, page) =>
    `<a href="${href}" class="nav-item ${activePage === page ? 'active' : ''}"><span class="icon">${icon}</span>${label}</a>`;
  const sidebar = user ? `
    <aside class="sidebar">
      <div class="sidebar-section">Navigation</div>
      ${navItem('/dashboard','🏠','Servers','dashboard')}
      ${navItem('/history','📜','History','history')}
      ${navItem('/liked','♥','Liked Songs','liked')}
      ${navItem('/terms','📄','Terms of Service','terms')}
      ${navItem('/privacy','🔒','Privacy Policy','privacy')}   ${navItem('/docs','📃','Documentations','docs')}
      <div class="sidebar-divider"></div>
      <div class="sidebar-section">Links</div>
      <a href="https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&scope=bot+applications.commands&permissions=4820673477601296" target="_blank" class="nav-item"><span class="icon">âž•</span>Add Bot</a>
    </aside>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AudioQuack - Best way to Quack your Music</title>
${FAVICON}
${GLOBAL_CSS}
</head>
<body>
<header class="topbar">
  <div class="topbar-logo"><img src="https://tr.rbxcdn.com/180DAY-cc9582e1a3a2740ac96ea118f56c24cf/420/420/ShoulderAccessory/Webp/noFilter" style="height:36px;width:36px;object-fit:contain"></div>
  <div class="topbar-right">
    ${user ? `
      <div class="user-chip">
        <img src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
        ${escHtml(user.username)}
      </div>
      <a href="/logout" class="logout-btn">Logout</a>
    ` : `<a href="/login" class="login-btn" style="padding:7px 16px;font-size:.85rem;margin:0">Login with Discord</a>`}
  </div>
</header>
<div class="app-body">
  ${sidebar}
  <main class="main">${body}</main>
</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPRESS DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  store: new FileStore({ path: './sessions', retries: 1, ttl: 365 * 24 * 60 * 60 }),
  secret: process.env.SESSION_SECRET || 'audioquack_secret',
  resave: true,
  saveUninitialized: false,
  cookie: { maxAge: 365 * 24 * 60 * 60 * 1000 },
}));

app.get('/503', (req, res) => {
  res.status(503).send('503 Internal Server Error');
});

const requireAuth = (req, res, next) => req.session.user ? next() : res.redirect('/login');

app.get('/login', (req, res) => {
  
  const params = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    redirect_uri: `${DASHBOARD_URL}/auth/callback`,
    response_type: 'code',
    scope: 'identify guilds',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${DASHBOARD_URL}/auth/callback`,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const { access_token } = tokenRes.data;
    const [userRes, guildsRes] = await Promise.all([
      axios.get(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` } }),
      axios.get(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: `Bearer ${access_token}` } }),
    ]);
    req.session.user = { ...userRes.data, guilds: guildsRes.data, access_token };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

  

function getBotGuilds(userGuilds) {
  return userGuilds.filter(g => client.guilds.cache.has(g.id));
}

// ── Landing ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="google-adsense-account" content="ca-pub-5874101786045442">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5874101786045442"
     crossorigin="anonymous"></script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5874101786045442"
     crossorigin="anonymous"></script>
<!-- Square Ads -->
<ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-5874101786045442"
     data-ad-slot="5377045830"
     data-ad-format="auto"
     data-full-width-responsive="true"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
<title>AudioQuack - Best way to Quack your Music</title>
${FAVICON}
${GLOBAL_CSS}
</head><body style="overflow:auto">
<div class="login-wrap">
  <div class="login-duck">🦆</div>
  <div class="login-title">AudioQuack</div>
  <div class="login-sub">Your Discord music bot dashboard. Control queues, browse history, and vibe with your server.</div>
  <a href="/login" class="login-btn">Login with Discord</a>
</div>
</body></html>`);
});

// ── Server list ───────────────────────────────────────────────────────────────
app.get('/dashboard', requireAuth, (req, res) => { 
  const user = req.session.user;
  const botGuilds = getBotGuilds(user.guilds || []);
  const guildCards = botGuilds.length ? botGuilds.map(g => {
    const iconUrl = g.icon
      ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;
    const queue = queues.get(g.id);
    const badge = queue?.isActive() ? `<div class="guild-status"><span class="pill pill-gold">🎵 Playing</span></div>` : '';
    return `<a href="/server/${g.id}" class="guild-card">
      <img class="guild-icon" src="${iconUrl}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
      <div class="guild-name">${escHtml(g.name)}</div>
      ${badge}
    </a>`;
  }).join('') : `<div class="empty" style="grid-column:1/-1">No shared servers found. Add the bot to a server first!</div>`;
    

  res.send(shell('Dashboard', `
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5874101786045442"
     crossorigin="anonymous"></script>
<!-- Square Ads -->
<ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-5874101786045442"
     data-ad-slot="5377045830"
     data-ad-format="auto"
     data-full-width-responsive="true"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5874101786045442"
     crossorigin="anonymous"></script>
    <meta name="google-adsense-account" content="ca-pub-5874101786045442">
    <div class="page-header">
      <div class="page-title">Your Servers</div>
<meta name="google-adsense-account" content="ca-pub-5874101786045442">
      <div class="page-sub">Select a server to manage music</div>
    </div><div class="guild-grid">${guildCards}</div>
<div id="scoplidrop-widget"></div>
<script src="https://www.scoplidrop.com/embed/widget.js" data-giveaway="E2LDCDJ" data-mode="modal"></script>
    <div class="card">
      <div class="card-header">
        <span class="card-title">📺 YouTube Player</span>
      </div>
      <div class="card-body">
        <div class="yt-wrap">
          <input class="search-input" type="text" id="yt-url" placeholder="Paste a YouTube URL to watch…" style="flex:1">
          <button class="ctrl-btn btn-surface" onclick="loadYT()">Load</button>
        </div>
        <div id="yt-container"><div class="empty" style="padding:60px">Paste a YouTube link above to watch it here</div></div>
      </div>
    </div>
    <script>
      function loadYT() {
        const url = document.getElementById('yt-url').value.trim();
        if (!url) return;
        const match = url.match(/(?:v=|youtu\\.be\\/)([\\w-]{11})/);
        if (!match) { alert('Invalid YouTube URL'); return; }
        document.getElementById('yt-container').innerHTML =
          '<iframe class="yt-frame" src="https://www.youtube.com/embed/' + match[1] + '?autoplay=1" allowfullscreen allow="autoplay"></iframe>';
      }
      document.getElementById('yt-url').addEventListener('keydown', e => { if (e.key === 'Enter') loadYT(); });
    </script>
  `, user, 'dashboard'));
});

// ── Server dashboard ──────────────────────────────────────────────────────────
app.get('/server/:guildId', requireAuth, (req, res) => {
  const user = req.session.user;
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.redirect('/dashboard');
  if (!user.guilds?.find(g => g.id === guild.id)) return res.redirect('/dashboard');

  const queue = queues.get(guild.id);
  const djRoleId = djRoles.get(guild.id);
  const djRole = djRoleId ? guild.roles.cache.get(djRoleId) : null;

  const npHtml = queue?.current ? `
    <div class="np-inner">
      ${queue.current.thumbnail
        ? `<img class="np-thumb" src="${escHtml(queue.current.thumbnail)}">`
        : `<div class="np-thumb-placeholder">🎵</div>`}
      <div class="np-info">
        <div class="np-label">Now Playing</div>
        <div class="np-title">${escHtml(queue.current.title)}</div>
        <div class="np-author">${escHtml(queue.current.author)}</div>
        <div class="np-meta">
          <span class="pill pill-gold">${fmtSecs(queue.current.duration)}</span>
          ${queue.loop !== 'off' ? `<span class="pill pill-muted">🔁 ${queue.loop}</span>` : ''}
          ${djRole ? `<span class="pill pill-muted">🎧 DJ: ${escHtml(djRole.name)}</span>` : ''}
        </div>
        <div class="controls">
          <button class="ctrl-btn btn-surface" onclick="api('pause')">⏸ Pause</button>
          <button class="ctrl-btn btn-surface" onclick="api('resume')">▶️ Resume</button>
          <button class="ctrl-btn btn-gold" onclick="api('skip')">⏭ Skip</button>
          <button class="ctrl-btn btn-red" onclick="api('stop')">⏹ Stop</button>
          <button class="ctrl-btn btn-surface" onclick="api('disconnect')">👋 DC</button>
        </div>
        <div class="vol-row">
          <span>🔊</span>
          <input type="range" min="0" max="150" value="${Math.round(queue.volume * 100)}" oninput="setVolume(this.value)">
          <span id="vol-label">${Math.round(queue.volume * 100)}%</span>
        </div>
      </div>
    </div>` : `<div class="empty" style="padding:32px">Nothing is playing right now. Use <strong>/play</strong> in Discord to start!</div>`;

  const queueHtml = queue?.tracks.length ? `
    <ul class="q-list">
      ${queue.tracks.slice(0,20).map((t, i) => `
        <li class="q-item">
          <span class="q-num">${i+1}</span>
          ${t.thumbnail ? `<img class="q-thumb" src="${escHtml(t.thumbnail)}">` : '<div class="q-thumb"></div>'}
          <div class="q-meta">
            <div class="q-title">${escHtml(t.title)}</div>
            <div class="q-sub">${escHtml(t.author)} • ${fmtSecs(t.duration)}</div>
          </div>
          <button class="q-remove" onclick="removeTrack(${i+1})" title="Remove">✕</button>
        </li>`).join('')}
      ${queue.tracks.length > 20 ? `<li class="q-item" style="justify-content:center;color:var(--muted);font-size:.8rem">+${queue.tracks.length - 20} more tracks</li>` : ''}
    </ul>` : `<div class="empty">Queue is empty.</div>`;

  const loopOptions = ['off','track','queue'].map(v =>
    `<option value="${v}" ${queue?.loop === v ? 'selected' : ''}>${v === 'off' ? '🚫 Off' : v === 'track' ? '🔂 Track' : '🔁 Queue'}</option>`
  ).join('');

  res.send(shell(guild.name, `
    <div class="page-header">
      <div class="page-title">${escHtml(guild.name)}</div>
      <div class="page-sub">Music dashboard</div>
    </div>
    <div class="two-col">
      <div style="display:flex;flex-direction:column;gap:20px">
        <div class="card np-card">${npHtml}</div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">🔍 Search &amp; Play</span>
          </div>
          <div class="card-body">
            <div class="search-wrap">
              <input class="search-input" type="text" id="search-input" placeholder="Search YouTube or paste URL…">
              <button class="ctrl-btn btn-gold" onclick="search()">Search</button>
            </div>
            <div id="search-results"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">📺 YouTube Player</span>
          </div>
          <div class="card-body">
            <div class="yt-wrap">
              <input class="search-input" type="text" id="yt-url" placeholder="Paste a YouTube URL…">
              <button class="ctrl-btn btn-surface" onclick="loadYT()">Load</button>
            </div>
            <div id="yt-container"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:20px">
        <div class="card">
          <div class="card-header">
            <span class="card-title">📋 Queue ${queue?.tracks.length ? `<span class="pill pill-gold" style="margin-left:6px">${queue.tracks.length}</span>` : ''}</span>
            <div style="display:flex;gap:8px;align-items:center">
              <select onchange="setLoop(this.value)">${loopOptions}</select>
              <button class="ctrl-btn btn-surface" style="padding:6px 10px;font-size:.75rem" onclick="api('shuffle')">🔀</button>
            </div>
          </div>
          ${queueHtml}
        </div>
      </div>
    </div>
    <script>
      const GUILD = '${guild.id}';
      async function api(action, body = {}) {
        const r = await fetch('/api/guild/' + GUILD + '/' + action, {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.ok) location.reload(); else alert(d.error || 'Error');
      }
      function setVolume(val) {
        document.getElementById('vol-label').textContent = val + '%';
        clearTimeout(window._volT);
        window._volT = setTimeout(() => api('volume', { level: parseInt(val) }), 400);
      }
      function setLoop(val) { api('loop', { mode: val }); }
      function removeTrack(pos) { if(confirm('Remove track #'+pos+'?')) api('remove', { position: pos }); }
      async function search() {
        const q = document.getElementById('search-input').value.trim();
        if (!q) return;
        document.getElementById('search-results').innerHTML = '<div class="empty">Searching…</div>';
        const r = await fetch('/api/search?q=' + encodeURIComponent(q));
        const tracks = await r.json();
        const el = document.getElementById('search-results');
        if (!tracks.length) { el.innerHTML = '<div class="empty">No results.</div>'; return; }
        el.innerHTML = '<div class="results-grid">' + tracks.map(t => \`
          <div class="r-card">
            <img class="r-thumb" src="\${t.thumbnail}" onerror="this.style.display='none'">
            <div class="r-info">
              <div class="r-title">\${t.title}</div>
              <div class="r-author">\${t.author}</div>
              <div class="r-dur">\${t.duration}</div>
            </div>
            <div class="r-actions">
              <button onclick="playTrack('\${encodeURIComponent(t.url)}','\${encodeURIComponent(t.title)}')">â–¶ Play</button>
              <button onclick="likeTrack(\${JSON.stringify(JSON.stringify(t))})">♥</button>
            </div>
          </div>
        \`).join('') + '</div>';
      }
      document.getElementById('search-input').addEventListener('keydown', e => { if(e.key==='Enter') search(); });
      async function playTrack(url, title) {
        const r = await fetch('/api/guild/' + GUILD + '/play', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ url: decodeURIComponent(url) })
        });
        const d = await r.json();
        alert(d.ok ? '🎵 Added: ' + decodeURIComponent(title) : d.error || 'Error');
        location.reload();
      }
      async function likeTrack(trackJson) {
        const track = JSON.parse(trackJson);
        const r = await fetch('/api/like', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(track) });
        const d = await r.json();
        alert(d.ok ? '♥ Liked!' : d.error || 'Error');
      }
      function loadYT() {
        const url = document.getElementById('yt-url').value.trim();
        if (!url) return;
        const match = url.match(/(?:v=|youtu\\.be\\/)([\\w-]{11})/);
        if (!match) { alert('Invalid YouTube URL'); return; }
        document.getElementById('yt-container').innerHTML =
          '<iframe class="yt-frame" src="https://www.youtube.com/embed/' + match[1] + '?autoplay=1" allowfullscreen allow="autoplay"></iframe>';
      }
      document.getElementById('yt-url').addEventListener('keydown', e => { if(e.key==='Enter') loadYT(); });
    </script>
  `, user, ''));
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/history', requireAuth, (req, res) => {
  const user = req.session.user;
  const u = getUser(user.id);
  const cards = u.history.length ? u.history.map(t => `
    <div class="t-card">
      <img class="t-thumb" src="${escHtml(t.thumbnail)}" onerror="this.style.display='none'">
      <div class="t-info">
        <div class="t-title">${escHtml(t.title)}</div>
        <div class="t-author">${escHtml(t.author)}</div>
        <div class="t-dur">${fmtSecs(t.duration)}</div>
      </div>
      <div class="t-actions">
        <a href="${escHtml(t.url)}" target="_blank">â–¶ Open on YouTube</a>
      </div>
    </div>`).join('') : `<div class="empty" style="grid-column:1/-1">No history yet. Play some songs in Discord first!</div>`;
  res.send(shell('History', `
    <div class="page-header">
      <div class="page-title">📜 History</div>
      <div class="page-sub">Last 50 tracks you played</div>
    </div>
    <div class="track-grid">${cards}</div>
  `, user, 'history'));
});

// ── Liked Songs ───────────────────────────────────────────────────────────────
app.get('/liked', requireAuth, (req, res) => {
  const user = req.session.user;
  const u = getUser(user.id);
  const cards = u.liked.length ? u.liked.map(t => `
    <div class="t-card">
      <img class="t-thumb" src="${escHtml(t.thumbnail)}" onerror="this.style.display='none'">
      <div class="t-info">
        <div class="t-title">${escHtml(t.title)}</div>
        <div class="t-author">${escHtml(t.author)}</div>
        <div class="t-dur">${fmtSecs(t.duration)}</div>
      </div>
      <div class="t-actions">
        <a href="${escHtml(t.url)}" target="_blank">â–¶ Open on YouTube</a>
        <button class="unlike-btn" onclick="unlike('${encodeURIComponent(t.url)}')">✕ Unlike</button>
      </div>
    </div>`).join('') : `<div class="empty" style="grid-column:1/-1">No liked songs yet. Like tracks from the server dashboard!</div>`;
  res.send(shell('Liked Songs', `
    <div class="page-header">
      <div class="page-title">♥ Liked Songs</div>
      <div class="page-sub">${u.liked.length} liked track${u.liked.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="track-grid">${cards}</div>
    <script>
      async function unlike(url) {
        await fetch('/api/unlike', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ url: decodeURIComponent(url) }) });
        location.reload();
      }
    </script>
  `, user, 'liked'));
});

// ─────────────────────────────────────────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/search', requireAuth, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  const results = await searchTracks(q, 8);
  res.json(results.map(t => ({ ...t, duration: fmtSecs(t.duration) })));
});

app.post('/api/like', requireAuth, (req, res) => {
  const u = getUser(req.session.user.id);
  const track = req.body;
  if (!track?.url) return res.json({ ok: false, error: 'No track data' });
  u.liked = [track, ...u.liked.filter(t => t.url !== track.url)].slice(0, 100);
  res.json({ ok: true });
});

app.post('/api/unlike', requireAuth, (req, res) => {
  const u = getUser(req.session.user.id);
  u.liked = u.liked.filter(t => t.url !== req.body.url);
  res.json({ ok: true });
});

app.post('/api/guild/:guildId/:action', requireAuth, async (req, res) => {
  const { guildId, action } = req.params;
  const user = req.session.user;
  if (!user.guilds?.find(g => g.id === guildId)) return res.json({ ok: false, error: 'Not in guild' });
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.json({ ok: false, error: 'Bot not in guild' });
    const DJ_ONLY_ACTIONS = ['stop', 'disconnect', 'volume', 'loop', 'shuffle', 'remove'];
if (DJ_ONLY_ACTIONS.includes(action)) {
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return res.json({ ok: false, error: 'Could not verify permissions.' });
  const djRoleId = djRoles.get(guildId);
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  const hasDJ = !djRoleId || member.roles.cache.has(djRoleId);
  if (!isAdmin && !hasDJ) return res.json({ ok: false, error: '❌ You need the DJ role to do that.' });
}
  const queue = queues.get(guildId);
  try {
    if (action === 'play') {
      const { url } = req.body;
      if (!url) return res.json({ ok: false, error: 'No URL provided' });
      const results = await searchTracks(url, 1);
      if (!results.length) return res.json({ ok: false, error: 'No results' });
      const track = results[0];
      if (!queue) return res.json({ ok: false, error: 'Bot is not in a voice channel. Use /play in Discord first.' });
      queue.addTrack(track, user.id);
      if (!queue.isActive() || (!queue.current && !queue.loading)) await queue.start();
      return res.json({ ok: true });
    }
    if (!queue) return res.json({ ok: false, error: 'Nothing is playing' });
    if (action === 'pause')      { queue.pause();   return res.json({ ok: true }); }
    if (action === 'resume')     { queue.resume();  return res.json({ ok: true }); }
    if (action === 'skip')       { queue.skip();    return res.json({ ok: true }); }
    if (action === 'stop')       { queue.destroy(); return res.json({ ok: true }); }
    if (action === 'disconnect') { queue.destroy(); return res.json({ ok: true }); }
    if (action === 'shuffle') {
      for (let i = queue.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
      }
      return res.json({ ok: true });
    }
    if (action === 'volume') {
      const level = parseInt(req.body.level);
      if (isNaN(level)) return res.json({ ok: false, error: 'Invalid level' });
      queue.setVolume(Math.max(0, Math.min(150, level)));
      return res.json({ ok: true });
    }
    if (action === 'loop') {
      const mode = req.body.mode;
      if (!['off','track','queue'].includes(mode)) return res.json({ ok: false, error: 'Invalid mode' });
      queue.loop = mode;
      return res.json({ ok: true });
    }
    if (action === 'remove') {
      const pos = parseInt(req.body.position) - 1;
      if (isNaN(pos) || pos < 0 || pos >= queue.tracks.length) return res.json({ ok: false, error: 'Invalid position' });
      queue.tracks.splice(pos, 1);
      return res.json({ ok: true });
    }
    res.json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('API error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});
// ── Terms of Service ──────────────────────────────────────────────────────────
app.get('/terms', (req, res) => {
  res.send(shell('Terms of Service', `
    <div class="page-header">
      <div class="page-title">Terms of Service</div>
      <div class="page-sub">Last updated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
<div class="page-sub">NOTE: 'Last Updated is US's Date.'</div>
    </div>
    <div class="card">
      <div class="card-body" style="display:flex;flex-direction:column;gap:24px;line-height:1.7;font-size:.9rem;color:var(--muted2)">

        <section>
          <div class="card-title" style="margin-bottom:8px">1. Acceptance of Terms</div>
          <p>By inviting AudioQuack to your Discord server or using the AudioQuack dashboard at <strong style="color:var(--text)">aqmusic.qzz.io</strong>, you agree to be bound by these Terms of Service. If you do not agree, please remove the bot from your server and discontinue use of the dashboard.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">2. Description of Service</div>
          <p>AudioQuack is a Discord music bot that streams audio from YouTube and provides a web dashboard for queue management. The service is provided free of charge and is operated independently. AudioQuack is not affiliated with Discord, YouTube, or Google.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">3. Eligibility</div>
          <p>You must be at least 13 years old to use AudioQuack, in compliance with Discord's own Terms of Service. By using AudioQuack, you confirm that you meet this age requirement and that your use complies with any local laws applicable to you.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">4. Acceptable Use</div>
          <p>You agree not to use AudioQuack to:</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li>Stream or distribute content in violation of copyright law</li>
            <li>Harass, abuse, or harm other users</li>
            <li>Attempt to exploit, reverse engineer, or disrupt the bot or dashboard</li>
            <li>Use the service for any unlawful purpose</li>
            <li>Spam commands or intentionally degrade service quality for others</li>
          </ul>
          <p style="margin-top:10px">Server administrators are responsible for ensuring their members use AudioQuack appropriately within their communities.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">5. Content & Copyright</div>
          <p>AudioQuack streams audio from YouTube using publicly available data. We do not host, store, or distribute any audio files. Users are responsible for ensuring their use of streamed content complies with applicable copyright law. AudioQuack does not endorse or take responsibility for any content streamed through the service.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">6. Service Availability</div>
          <p>AudioQuack is provided on an <strong style="color:var(--text)">"as is"</strong> and <strong style="color:var(--text)">"as available"</strong> basis. We do not guarantee uninterrupted or error-free operation. The service may be modified, suspended, or discontinued at any time without prior notice. We are not liable for any downtime or loss of access.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">7. Dashboard & Authentication</div>
          <p>The AudioQuack dashboard uses Discord OAuth2 for authentication. By logging in, you grant AudioQuack read-only access to your Discord username, avatar, and server list solely for dashboard functionality. We do not store your Discord access token beyond your active session.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">8. Limitation of Liability</div>
          <p>To the fullest extent permitted by law, AudioQuack and its operators shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of or inability to use the service, including but not limited to loss of data or service interruptions.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">9. Changes to Terms</div>
          <p>We reserve the right to update these Terms of Service at any time. Continued use of AudioQuack after changes are posted constitutes your acceptance of the updated terms. We encourage you to review this page periodically.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">10. Contact</div>
          <p>If you have questions about these terms, you can reach us through the AudioQuack Discord support server or via the dashboard.</p>
        </section>

        <div style="padding:16px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;font-size:.82rem;color:var(--muted)">
          By using AudioQuack, you acknowledge that you have read and understood these Terms of Service and agree to be bound by them.
        </div>
      </div>
    </div>
  `, req.session.user ?? null, ''));
});

// ── Privacy Policy ────────────────────────────────────────────────────────────
app.get('/privacy', (req, res) => {
  res.send(shell('Privacy Policy', `
    <meta name="google-adsense-account" content="ca-pub-5874101786045442">
    <div class="page-header">
      <div class="page-title">Privacy Policy</div>
      <div class="page-sub">Last updated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
    </div>
    <div class="card">
      <div class="card-body" style="display:flex;flex-direction:column;gap:24px;line-height:1.7;font-size:.9rem;color:var(--muted2)">

        <section>
          <div class="card-title" style="margin-bottom:8px">1. Overview</div>
          <p>AudioQuack ("we", "our", "the bot") is committed to protecting your privacy. This Privacy Policy explains what information we collect, how we use it, and your rights regarding that information when you use AudioQuack or the dashboard at <strong style="color:var(--text)">aqmusic.qzz.io</strong>.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">2. Information We Collect</div>
          <p>We collect only the minimum information necessary to provide the service:</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li><strong style="color:var(--text)">Discord User ID, username & avatar</strong> — collected via Discord OAuth2 when you log into the dashboard, used solely to display your profile and identify your session</li>
            <li><strong style="color:var(--text)">Server (guild) list</strong> — fetched from Discord to show which servers you share with the bot; not stored permanently</li>
            <li><strong style="color:var(--text)">Playback history</strong> — tracks you play through the bot are stored in memory to power the History feature; this data is lost on bot restart</li>
            <li><strong style="color:var(--text)">Liked songs</strong> — tracks you like via the dashboard are stored in memory per-user; also lost on restart</li>
            <li><strong style="color:var(--text)">DJ role settings</strong> — server-specific DJ role configurations are saved to disk (<code style="background:var(--surface2);padding:1px 5px;border-radius:3px">djroles.json</code>) to persist across restarts</li>
            <li><strong style="color:var(--text)">Session data</strong> — login sessions are stored in files on the server to keep you logged into the dashboard for up to 1 year unless you log out</li>
          </ul>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">3. Information We Do NOT Collect</div>
          <ul style="padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li>We do not collect or store your Discord password or email</li>
            <li>We do not store your Discord OAuth2 access token beyond your active session</li>
            <li>We do not collect message content from your Discord servers</li>
            <li>We do not sell, trade, or share your data with any third parties</li>
            <li>We do not use analytics or tracking services</li>
          </ul>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">4. How We Use Your Information</div>
          <p>Information collected is used exclusively to:</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li>Authenticate you on the dashboard and keep you logged in</li>
            <li>Display your playback history and liked songs</li>
            <li>Show which servers you share with AudioQuack</li>
            <li>Persist DJ role configuration per server</li>
          </ul>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">5. Data Storage & Security</div>
          <p>Session files are stored on the server hosting AudioQuack. Playback history and liked songs exist only in memory and are not written to disk — they will be cleared whenever the bot restarts. We take reasonable precautions to protect stored data, but no system is completely secure. Use of the service is at your own risk.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">6. Third-Party Services</div>
          <p>AudioQuack interacts with the following third-party services:</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li><strong style="color:var(--text)">Discord</strong> — for bot functionality and OAuth2 login. Subject to <a href="https://discord.com/privacy" target="_blank" style="color:var(--gold)">Discord's Privacy Policy</a></li>
            <li><strong style="color:var(--text)">YouTube / Google</strong> — audio is streamed from YouTube. Subject to <a href="https://policies.google.com/privacy" target="_blank" style="color:var(--gold)">Google's Privacy Policy</a></li>
            <li><strong style="color:var(--text)">Google Fonts</strong> — fonts are loaded from Google's CDN for the dashboard UI</li>
          </ul>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">7. Your Rights</div>
          <p>You can:</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li><strong style="color:var(--text)">Log out</strong> at any time to clear your dashboard session</li>
            <li><strong style="color:var(--text)">Remove the bot</strong> from your server at any time via Discord server settings</li>
            <li><strong style="color:var(--text)">Request data deletion</strong> by contacting us — since most data is in-memory only, a bot restart effectively clears user data</li>
          </ul>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">8. Children's Privacy</div>
          <p>AudioQuack is not directed at children under 13. We do not knowingly collect information from children under 13. If you believe a child under 13 has provided us with personal information, please contact us so we can remove it.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">9. Changes to This Policy</div>
          <p>We may update this Privacy Policy from time to time. Changes will be reflected by an updated date at the top of this page. Continued use of AudioQuack after changes constitutes acceptance of the updated policy.</p>
        </section>

        <section>
          <div class="card-title" style="margin-bottom:8px">10. Contact</div>
          <p>If you have any questions or concerns about this Privacy Policy or your data, please reach out via the AudioQuack Discord support server or through the dashboard.</p>
        </section>

        <div style="padding:16px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;font-size:.82rem;color:var(--muted)">
          Your privacy matters. AudioQuack collects only what's needed to function and nothing more.
        </div>
      </div>
    </div>
  `, req.session.user ?? null, ''));
});
// ── Docs ──────────────────────────────────────────────────────────────────────
app.get('/docs', (req, res) => {
  res.send(shell('Documentation', `
    <div class="page-header">
      <div class="page-title">📖 Documentation</div>
      <div class="page-sub">Everything you need to know about AudioQuack</div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">📑 Table of Contents</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:8px;font-size:.9rem">
        <a href="#installation" style="color:var(--gold)">1. Installation & Setup</a>
        <a href="#dashboard" style="color:var(--gold)">2. Using the Dashboard</a>
        <a href="#commands" style="color:var(--gold)">3. Bot Commands</a>
        <a href="#dj" style="color:var(--gold)">4. DJ Role System</a>
        <a href="#faq" style="color:var(--gold)">5. FAQ</a>
      </div>
    </div>

    <div class="card" id="installation">
      <div class="card-header"><span class="card-title">🚀 1. Installation & Setup</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:20px;line-height:1.7;font-size:.9rem;color:var(--muted2)">
        <section>
          <div class="card-title" style="margin-bottom:8px">Adding the Bot to Your Server</div>
          <p>To add AudioQuack to your Discord server, click the <strong style="color:var(--gold)">âž• Add Bot</strong> link in the left sidebar (you must be logged in). You'll be taken to Discord's authorization page where you can select which server to add it to.</p>
          <p style="margin-top:8px">You need <strong style="color:var(--text)">Manage Server</strong> permission in the target server to add bots.</p>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">Required Bot Permissions</div>
          <p>AudioQuack needs the following permissions to function correctly:</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li><strong style="color:var(--text)">Connect</strong> — to join voice channels</li>
            <li><strong style="color:var(--text)">Speak</strong> — to play audio in voice channels</li>
            <li><strong style="color:var(--text)">Send Messages</strong> — to send now playing and queue notifications</li>
            <li><strong style="color:var(--text)strong">Use Application Commands</strong> — to register and respond to slash commands</li>
          </ul>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">First Steps After Adding</div>
          <ol style="padding-left:20px;display:flex;flex-direction:column;gap:8px">
            <li>Join a voice channel in your server</li>
            <li>Type <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/play</code> followed by a song name or YouTube URL</li>
            <li>AudioQuack will join your voice channel and start playing</li>
            <li>Log into the dashboard at <strong style="color:var(--gold)">aqmusic.qzz.io</strong> to control music from your browser</li>
          </ol>
        </section>
      </div>
    </div>

    <div class="card" id="dashboard">
      <div class="card-header"><span class="card-title">🖥️ 2. Using the Dashboard</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:20px;line-height:1.7;font-size:.9rem;color:var(--muted2)">
        <section>
          <div class="card-title" style="margin-bottom:8px">Logging In</div>
          <p>Click <strong style="color:var(--gold)">Login with Discord</strong> on the homepage. You'll be redirected to Discord to authorize AudioQuack to read your username and server list. No messages or sensitive data are accessed. Your session stays active for up to 1 year unless you log out.</p>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">Server List</div>
          <p>After logging in you'll see your <strong style="color:var(--text)">Servers</strong> page — a grid of all Discord servers you share with AudioQuack. Servers actively playing music show a <span class="pill pill-gold" style="font-size:.72rem">🎵 Playing</span> badge. Click any server to open its music dashboard.</p>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">Server Dashboard</div>
          <p>The server dashboard has three main areas:</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:8px">
            <li><strong style="color:var(--text)">Now Playing</strong> — shows the current track with thumbnail, artist, duration, and playback controls (Pause, Resume, Skip, Stop, Disconnect). Also includes a volume slider (0–150%).</li>
            <li><strong style="color:var(--text)">Search & Play</strong> — search YouTube directly from the dashboard or paste a URL. Results appear as cards you can play or like instantly.</li>
            <li><strong style="color:var(--text)">Queue</strong> — view the upcoming tracks, reorder by shuffling, set loop mode, and remove individual tracks with the ✕ button.</li>
          </ul>
          <p style="margin-top:10px"><strong style="color:var(--text)">Note:</strong> The bot must already be in a voice channel (started via <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/play</code> in Discord) before you can control it from the dashboard.</p>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">YouTube Player</div>
          <p>Both the Servers page and each server dashboard include an embedded <strong style="color:var(--text)">YouTube Player</strong>. Paste any YouTube URL and click Load (or press Enter) to watch it directly in the dashboard without leaving the page.</p>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">History</div>
          <p>The <strong style="color:var(--text)">History</strong> page tracks the last 50 songs you've played through AudioQuack. Tracks are recorded per-user and stored in memory — they reset when the bot restarts. Click <strong style="color:var(--text)">Open on YouTube</strong> to revisit any track.</p>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">Liked Songs</div>
          <p>You can <strong style="color:var(--text)">♥ Like</strong> any track from the search results on a server dashboard. Liked songs are stored per-user (up to 100 tracks) and accessible from the sidebar. Unlike a song at any time with the ✕ Unlike button.</p>
        </section>
      </div>
    </div>

    <div class="card" id="commands">
      <div class="card-header"><span class="card-title">⌨️ 3. Bot Commands</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:0;font-size:.88rem">
        ${[
          ['/play [query]', 'Plays a Song via AQ by name or URL. Supports autocomplete — type a few letters and suggestions appear.', false],
          ['/skip', 'Skip the currently playing track and move to the next one in the queue.', false],
          ['/pause', 'Pause playback. The bot stays in the channel.', false],
          ['/resume', 'Resume paused playback.', false],
          ['/nowplaying', 'Show an embed with the currently playing track, artist, duration, and queue count.', false],
          ['/queue [page]', 'View the current queue with pagination. Use the â—€ Prev / Next â–¶ buttons to browse pages.', false],
          ['/stop', 'Stop playback and clear the entire queue. Bot stays in the channel. (DJ only)', true],
          ['/disconnect', 'Stop playback, clear the queue, and disconnect the bot from the voice channel. (DJ only)', true],
          ['/volume [0-150]', 'Set the playback volume between 0% and 150%. Default is 80%. (DJ only)', true],
          ['/loop [mode]', 'Set loop mode: Off (no loop), Track (repeat current song), or Queue (repeat all). (DJ only)', true],
          ['/shuffle', 'Randomly shuffle all tracks in the queue. (DJ only)', true],
          ['/remove [position]', 'Remove a specific track from the queue by its position number. (DJ only)', true],
          ['/dj set [@role]', 'Set a DJ role for your server. Only admins can run this.', true],
          ['/dj remove', 'Remove the DJ role restriction so anyone can use all commands.', true],
          ['/dj show', 'Show the currently configured DJ role.', true],
          ['/seek [seconds]', 'Seek to a position in the current track in seconds.', false],
		['/clearqueue', 'Clear the queue without stopping the current track. (DJ only)', true],
['/move [from] [to]', 'Move a track from one queue position to another. (DJ only)', true],
        ].map(([cmd, desc, dj]) => `
          <div style="display:flex;align-items:flex-start;gap:16px;padding:12px 0;border-bottom:1px solid var(--border)">
            <div style="min-width:200px;flex-shrink:0">
              <code style="background:var(--surface2);padding:3px 8px;border-radius:5px;font-size:.8rem;color:var(--gold)">${cmd}</code>
              ${dj ? `<span class="pill pill-muted" style="margin-left:6px;font-size:.65rem">DJ</span>` : ''}
            </div>
            <div style="color:var(--muted2);line-height:1.5">${desc}</div>
          </div>`).join('')}
        <div style="padding-top:12px;font-size:.8rem;color:var(--muted)">
          <span class="pill pill-muted">DJ</span> = Requires DJ role or Administrator permission. See section 4.
        </div>
      </div>
    </div>

    <div class="card" id="dj">
      <div class="card-header"><span class="card-title">🎧 4. DJ Role System</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:20px;line-height:1.7;font-size:.9rem;color:var(--muted2)">
        <section>
          <div class="card-title" style="margin-bottom:8px">How It Works</div>
          <p>AudioQuack has a DJ role system to control who can use powerful commands like <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/stop</code>, <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/volume</code>, <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/loop</code>, and <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/shuffle</code>.</p>
          <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li><strong style="color:var(--text)">Administrators</strong> always have full access regardless of DJ role settings</li>
            <li>If <strong style="color:var(--text)">no DJ role is set</strong>, everyone can use all commands</li>
            <li>If a <strong style="color:var(--text)">DJ role is set</strong>, only members with that role (or admins) can use DJ-only commands</li>
          </ul>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">Setting Up a DJ Role</div>
          <ol style="padding-left:20px;display:flex;flex-direction:column;gap:8px">
            <li>Create a role in your Discord server (e.g. "DJ" or "Music Manager")</li>
            <li>Run <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/dj set @YourRole</code> in any channel (requires Administrator)</li>
            <li>Assign the role to trusted members</li>
            <li>To remove the restriction, run <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">/dj remove</code></li>
          </ol>
        </section>
        <section>
          <div class="card-title" style="margin-bottom:8px">DJ Role Persistence</div>
          <p>DJ role settings are saved to disk and persist across bot restarts. Each server has its own independent DJ role configuration.</p>
        </section>
      </div>
    </div>

    <div class="card" id="faq">
      <div class="card-header"><span class="card-title">❓ 5. FAQ</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:20px;line-height:1.7;font-size:.9rem;color:var(--muted2)">
        ${[
          ['Why isn\'t the bot joining my voice channel?', 'Make sure you\'re in a voice channel before using /play. The bot needs Connect and Speak permissions in that channel. If it still doesn\'t join, try /disconnect and then /play again.'],
          ['Why can\'t I control music from the dashboard?', 'The bot must be actively in a voice channel in Discord first. Start playback with /play in Discord, then use the dashboard to control it.'],
          ['Why does my history reset?', 'History and liked songs are stored in memory for performance reasons and reset when the bot restarts. This is by design — see the Privacy Policy for details.'],
          ['The bot left the voice channel on its own — why?', 'AudioQuack automatically disconnects 30 seconds after the queue finishes to avoid sitting idle in channels.'],
          ['Can I use the dashboard without being in the server?', 'No. The dashboard only shows servers you share with the bot. You must be a member of the server to access its dashboard.'],
          ['Volume above 100% — is that safe?', 'Yes, up to 150% is supported but may cause audio distortion at high levels depending on the source. 80% (default) is recommended for most use cases.'],
          ['Why did my liked songs disappear?', 'Liked songs are stored in memory and are lost on bot restart. This is a known limitation — persistent storage may be added in a future update.'],
          ['How do I report a bug or get support?', 'Join the AudioQuack Discord support server or reach out through the dashboard contact options.'],
        ].map(([q, a]) => `
          <section>
            <div class="card-title" style="margin-bottom:6px;font-size:.88rem">${q}</div>
            <p>${a}</p>
          </section>`).join('<div style="height:1px;background:var(--border)"></div>')}
      </div>
    </div>
  `, req.session.user ?? null, 'docs'));
});


// ─────────────────────────────────────────────────────────────────────────────
//  BOT BOOT
// ─────────────────────────────────────────────────────────────────────────────
client.commands = new Collection();
for (const cmd of commands) client.commands.set(cmd.data.name, cmd);

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands.map(c => c.data.toJSON()) });
      console.log('✅ Guild commands registered');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c => c.data.toJSON()) });
      console.log('✅ Global commands registered (~1hr propagation)');
    }
  } catch (err) { console.error('❌ Failed to register commands:', err); }
}

client.once('ready', async () => {
  console.log(`\n🦆 AudioQuack online as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'aqmusic.qzz.io', type: ActivityType.Watching }], status: 'online' });
  await registerCommands();
  console.log('✅ Bot ready!');
});

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd?.autocomplete) try { await cmd.autocomplete(interaction); } catch {}
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`❌ /${interaction.commandName}:`, err);
    const payload = { embeds: [simple('❌ Something went wrong.', C.red)], ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  }
});

client.login(process.env.DISCORD_TOKEN);

app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT} → ${DASHBOARD_URL}`));
