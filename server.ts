import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import puppeteer from 'puppeteer-core';
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionType,
  ComponentType,
  ModalActionRowComponentBuilder,
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import dotenv from 'dotenv';
import { db, serverTimestamp, getBotConfig, updateBotConfig, getGuildConfig, updateGuildConfig } from './firebase.ts';
import { checkCashAppPayment } from './cashapp.ts';
import { checkEmailPayment, testPaymentEmail, inspectLatestPaymentEmail } from './email-payments.ts';
import { testZelleConnection } from './zelle.ts';

dotenv.config();

// --- UI Helpers ---
function makeSelect(customId: string, placeholder: string, options: { label: string; value: string }[], extra?: { min?: number; max?: number }) {
  const s = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options);
  if (extra?.min !== undefined) s.setMinValues(extra.min);
  if (extra?.max !== undefined) s.setMaxValues(extra.max);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(s);
}

function makeInput(customId: string, label: string, style: TextInputStyle, opts: { value?: string; placeholder?: string; required?: boolean } = {}) {
  const i = new TextInputBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (opts.value !== undefined) i.setValue(opts.value);
  if (opts.placeholder !== undefined) i.setPlaceholder(opts.placeholder);
  if (opts.required !== undefined) i.setRequired(opts.required);
  return new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(i);
}

function applyReplacements(template: string, map: Record<string, string>) {
  return Object.entries(map).reduce((s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, 'g'), v), template);
}

const ORDER_STATUS_OPTIONS = [
  { label: '🕐 Pending', value: 'pending' },
  { label: '💸 Pending Cash App', value: 'pending_cashapp' },
  { label: '🔵 Pending Venmo', value: 'pending_venmo' },
  { label: '🟣 Pending Zelle', value: 'pending_zelle' },
  { label: '🅿️ Pending PayPal', value: 'pending_paypal' },
  { label: '🪙 Pending Crypto', value: 'pending_crypto' },
  { label: '✅ Paid', value: 'paid' },
  { label: '🎉 Fulfilled', value: 'paid_fulfilled' },
];

const CONFIRM_ALL_STATUS_MAP: Record<string, { status: string; name: string }> = {
  admin_confirm_all_cashapp:  { status: 'pending_cashapp', name: 'Cash App ' },
  admin_confirm_all_venmo:    { status: 'pending_venmo',   name: 'Venmo ' },
  admin_confirm_all_zelle:    { status: 'pending_zelle',   name: 'Zelle ' },
  admin_confirm_all_paypal:   { status: 'pending_paypal',  name: 'PayPal ' },
  admin_confirm_all_crypto:   { status: 'pending_crypto',  name: 'Crypto ' },
  admin_confirm_all_pending:  { status: 'pending',         name: 'pending ' },
};

// --- Input Sanitization ---
// Strips Discord markdown/mention exploits and enforces length limits.
function sanitizeInput(input: string, maxLength: number = 200): string {
  return input
    .replace(/@(everyone|here)/gi, '@\u200B$1')   // Neutralize @everyone / @here
    .replace(/<@[!&]?\d+>/g, '[mention]')          // Strip user/role mentions
    .replace(/\n/g, ' ')                           // Collapse newlines
    .slice(0, maxLength)
    .trim();
}

// Validates that a webhook URL is a legitimate Discord webhook
function isValidDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
      parsed.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

function createEmbed(config: any) {
  const embed = new EmbedBuilder();
  if (config?.embedColor) {
    try {
      embed.setColor(config.embedColor);
    } catch (e) {
      embed.setColor(0xFF6321);
    }
  } else {
    embed.setColor(0xFF6321);
  }

  const displayName = config?.botDisplayName || 'Burrito.exe';
  const avatarUrl = client.user?.displayAvatarURL({ size: 64 });
  embed.setAuthor({ name: displayName, ...(avatarUrl ? { iconURL: avatarUrl } : {}) });

  if (config?.footerText) {
    embed.setFooter({ text: config.footerText });
  }

  return embed;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGO_PATH = path.join(__dirname, 'public', 'logo.png');

// Initialize Discord Client and State
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ]
});
const orderState = new Map<string, any>();
const pendingFoodieOrders = new Map<string, { customers: any[]; config: any; createdAt?: number }>(); // userId:guildId → pending foodie parse

const QUEUE_SCHEDULE_TEXT = `📋 **How Our Queue Works**
The queue opens **2 hours before** each placement time. Once the queue opens, submit your order at any point before the placement deadline. Your pickup time must be at least **45 minutes after** the placement time.

⏰ **Daily Schedule (4 rounds)**

🌙 **Round 1 — Placement: 8:45 AM PST / 11:45 AM EST** *(Overnight Orders)*
> Queue opens: 6:45 AM PST / 9:45 AM EST
> Earliest pickup: **9:30 AM PST / 12:30 PM EST**

☀️ **Round 2 — Placement: 11:45 AM PST / 2:45 PM EST**
> Queue opens: 9:45 AM PST / 12:45 PM EST
> Earliest pickup: **12:30 PM PST / 3:30 PM EST**

🌆 **Round 3 — Placement: 2:45 PM PST / 5:45 PM EST**
> Queue opens: 12:45 PM PST / 3:45 PM EST
> Earliest pickup: **3:30 PM PST / 6:30 PM EST**

🌇 **Round 4 — Placement: 4:45 PM PST / 7:45 PM EST**
> Queue opens: 2:45 PM PST / 5:45 PM EST
> Earliest pickup: **5:30 PM PST / 8:30 PM EST**

🚫 **Important Rules**
• If you open a ticket even **1 minute after** the placement time, you will be placed on the **next batch** — no exceptions.
• Once an order is submitted, it **cannot be edited**.
• Late submissions disrupt the flow for everyone.`;
const cashappPollers = new Map<string, { interval: ReturnType<typeof setInterval>, timeout: ReturnType<typeof setTimeout> }>();
// zellePollers removed — Zelle uses emailPaymentPollers
const emailPaymentPollers = new Map<string, { interval: ReturnType<typeof setInterval>, timeout: ReturnType<typeof setTimeout> }>();
const depositPollers = new Map<string, { interval: ReturnType<typeof setInterval>, timeout: ReturnType<typeof setTimeout> }>();
// Track email UIDs already used so the same notification can't confirm two orders
const emailUsedUids  = new Set<string>();
// Cleanup stale orders and pending foodie orders every hour to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of orderState.entries()) {
    if (state.lastUpdated && now - state.lastUpdated > 3600000) {
      orderState.delete(key);
    }
  }
  for (const [key, entry] of pendingFoodieOrders.entries()) {
    if (entry.createdAt && now - entry.createdAt > 3600000) {
      pendingFoodieOrders.delete(key);
    }
  }
}, 3600000);

function safeParseOrders(data: any): any[] {
  try {
    const parsed = JSON.parse(data || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function safeParseUserInfo(data: any): any {
  try {
    const parsed = JSON.parse(data || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    return {};
  }
}

function generateShortOrderId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  let id = '';
  for (let i = 0; i < 3; i++) id += letters.charAt(Math.floor(Math.random() * letters.length));
  for (let i = 0; i < 3; i++) id += numbers.charAt(Math.floor(Math.random() * numbers.length));
  // Append timestamp suffix to prevent collisions under high load
  id += Date.now().toString(36).slice(-2).toUpperCase();
  return id;
}

function formatConfirmedOrderPayload(userId: string, userInfo: any, parsedOrders: any[], config?: any) {
  const headerFmt = config?.orderHeaderFormat || `Customer: {discord}\nPickup Location: {location}\nPickup Time: {time}\nPhone: {phone}\nEmail: {email}`;
  const itemFmt = config?.orderItemFormat || `Order {#}\n{name}\n{entree}\n{protein}\n{rice}\n{beans}\n{toppings}\n{premium}`;

  const header = applyReplacements(headerFmt, {
    discord: `<@${userId}>`,
    name: userInfo.name || 'N/A',
    location: userInfo.location || 'N/A',
    time: userInfo.time || 'N/A',
    phone: userInfo.phone || 'N/A',
    email: userInfo.email || 'N/A',
  });

  const ordersStr = parsedOrders.map((order: any, index: number) => {
    const proteinStr = order.isDouble
      ? `Double ${order.proteins[0]}`
      : order.proteins[0] || 'Veggie';

    const toppingsList = order.toppings
      .map((t: any) => t.portion === 'Regular' ? t.type : `${t.portion} ${t.type}`)
      .join('\n') || 'None';

    const riceStr = order.rice.type === 'None' ? '' : (order.rice.portion && order.rice.portion !== 'Regular' ? `${order.rice.portion} ${order.rice.type}` : order.rice.type);
    const beansStr = order.beans.type === 'None' ? '' : (order.beans.portion && order.beans.portion !== 'Regular' ? `${order.beans.portion} ${order.beans.type}` : order.beans.type);

    const premiumStr = order.premiums && order.premiums.length > 0 ? order.premiums.join('\n') : '';

    return applyReplacements(itemFmt, {
      '#': String(index + 1),
      name: userInfo.name || 'N/A',
      entreeName: order.entreeName || userInfo.name || 'N/A',
      entree: order.type,
      protein: proteinStr,
      rice: riceStr,
      beans: beansStr,
      toppings: toppingsList,
      premium: premiumStr,
    }).split('\n').filter((line: string) => line.trim() !== '').join('\n');
  }).join('\n\n');

  return `${header}\n\n${ordersStr}`;
}

function formatOrderItems(parsedOrders: any[]) {
  return parsedOrders.map((order: any, index: number) => {
    const proteinStr = order.isDouble 
      ? `Double ${order.proteins[0]}` 
      : order.proteins[0] || 'Veggie';
    
    const toppingLines = [
      ...order.toppings.map((t: any) => t.portion === 'Regular' ? `${t.type}` : `${t.portion} ${t.type}`),
      ...(order.premiums && order.premiums.length > 0 ? order.premiums : []),
    ].filter(Boolean).join('\n');

    const riceStr = order.rice.portion && order.rice.portion !== 'Regular' 
      ? `${order.rice.portion} ${order.rice.type}` 
      : `${order.rice.type}`;
      
    const beansStr = order.beans.portion && order.beans.portion !== 'Regular' 
      ? `${order.beans.portion} ${order.beans.type}` 
      : `${order.beans.type}`;

    const nameLabel = order.entreeName ? ` — ${order.entreeName}` : '';
    return `Order ${index + 1}${nameLabel}\n${order.type}\n${proteinStr}\n${riceStr}\n${beansStr}\n${toppingLines}`;
  }).join('\n\n');
}

// Define Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('order')
    .setDescription('Start a new Chipotle order')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('reorder')
    .setDescription('Repeat your last order with one click')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('myorders')
    .setDescription('See your queued orders and status')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Check your credit balance')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Add funds to your wallet using Cash App, Venmo, Zelle, or PayPal')
    .setDefaultMemberPermissions(null)
    .addNumberOption(opt =>
      opt.setName('amount').setDescription('Amount to deposit (e.g. 20.00)').setRequired(true).setMinValue(1).setMaxValue(500)
    ),
  new SlashCommandBuilder()
    .setName('support')
    .setDescription('Open a support ticket in the server')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Shows how the bot works')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('menu')
    .setDescription('View the current menu and options')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('View queue times, pickup rules, and how ordering works')
    .setDefaultMemberPermissions(null),
  new SlashCommandBuilder()
    .setName('manualorder')
    .setDescription('Create an order and print it in confirmed-order format — no payment required')
    .setDefaultMemberPermissions(null),
  // /orders — merged: orders (view), admin_orders (manage), admin_batch (batch), pending (pending)
  new SlashCommandBuilder()
    .setName('orders')
    .setDescription('Order queue management (Admin/Staff)')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View all queued orders from your customers')
    )
    .addSubcommand(sub =>
      sub.setName('manage')
        .setDescription('View and manage orders (Admin only)')
    )
    .addSubcommand(sub =>
      sub.setName('batch')
        .setDescription('View and clear the current order batch (Admin only)')
    )
    .addSubcommand(sub =>
      sub.setName('pending')
        .setDescription('View all pending orders and confirm them (Admin only)')
    ),
  // /payment — merged: cashapp, zelle, paymentemail (setup/test/clear), verifypayment
  new SlashCommandBuilder()
    .setName('payment')
    .setDescription('Payment provider setup and verification (Admin only)')
    .addSubcommand(sub =>
      sub.setName('cashapp')
        .setDescription('Configure Cash App settings for this server')
    )
    .addSubcommand(sub =>
      sub.setName('zelle')
        .setDescription('Configure Zelle auto-verification for this server')
    )
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Set up shared email inbox for automatic payment verification (private modal)')
    )
    .addSubcommand(sub =>
      sub.setName('test')
        .setDescription('Test the saved payment email credentials')
    )
    .addSubcommand(sub =>
      sub.setName('clear')
        .setDescription('Remove saved payment email credentials')
    )
    .addSubcommand(sub =>
      sub.setName('verify')
        .setDescription('Scan inbox for a recent payment and show what was read')
        .addStringOption(o =>
          o.setName('provider')
            .setDescription('Payment provider to look for')
            .setRequired(true)
            .addChoices(
              { name: 'Cash App', value: 'cashapp' },
              { name: 'Venmo',    value: 'venmo'   },
              { name: 'Zelle',    value: 'zelle'   },
              { name: 'PayPal',   value: 'paypal'  },
            )
        )
        .addNumberOption(o =>
          o.setName('amount').setDescription('Expected payment amount (e.g. 12.50)').setRequired(true)
        )
        .addStringOption(o =>
          o.setName('order_id').setDescription('Order ID to match against memo').setRequired(false)
        )
        .addIntegerOption(o =>
          o.setName('lookback').setDescription('How many minutes back to search (default 45)').setRequired(false)
        )
    ),
  // /setup — merged: config, settings, admin_setup
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Bot configuration and server setup (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('config')
        .setDescription('Configure bot messages')
    )
    .addSubcommand(sub =>
      sub.setName('settings')
        .setDescription('Quick panel to reconfigure everything at once')
    )
    .addSubcommand(sub =>
      sub.setName('main')
        .setDescription('Configure the bot for your server — webhooks, payments, and more')
    ),
  // /report — merged: revenue, history, stats, customers, export
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Reports and analytics (Admin only)')
    .addSubcommand(sub =>
      sub.setName('revenue')
        .setDescription('Detailed revenue report (daily/weekly/monthly)')
    )
    .addSubcommand(sub =>
      sub.setName('history')
        .setDescription('Past order history with results')
    )
    .addSubcommand(sub =>
      sub.setName('stats')
        .setDescription("Today's order snapshot — count, revenue, avg size, top items")
    )
    .addSubcommand(sub =>
      sub.setName('customers')
        .setDescription('See your top customers by order count')
    )
    .addSubcommand(sub =>
      sub.setName('export')
        .setDescription('Export all orders to a CSV file')
    ),
  // /round — merged: pause, roundsummary, exportround
  new SlashCommandBuilder()
    .setName('round')
    .setDescription('Queue round management (Admin only)')
    .addSubcommand(sub =>
      sub.setName('pause')
        .setDescription('Pause or resume a queue round')
        .addStringOption(option =>
          option.setName('round')
            .setDescription('Which round to pause/resume')
            .setRequired(true)
            .addChoices(
              { name: 'Round 1 (8:45 AM PST)', value: '1' },
              { name: 'Round 2 (11:45 AM PST)', value: '2' },
              { name: 'Round 3 (2:45 PM PST)', value: '3' },
              { name: 'Round 4 (4:45 PM PST)', value: '4' },
              { name: 'All Rounds', value: 'all' },
            )
        )
        .addStringOption(option =>
          option.setName('action')
            .setDescription('Pause or resume')
            .setRequired(true)
            .addChoices(
              { name: '⏸️ Pause', value: 'pause' },
              { name: '▶️ Resume', value: 'resume' },
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('summary')
        .setDescription("Show a full breakdown of today's orders for a given round")
        .addIntegerOption(option =>
          option.setName('round').setDescription('Round number').setRequired(true)
            .addChoices(
              { name: 'Round 1 — Placement 8:45 AM', value: 1 },
              { name: 'Round 2 — Placement 11:45 AM', value: 2 },
              { name: 'Round 3 — Placement 2:45 PM',  value: 3 },
              { name: 'Round 4 — Placement 4:45 PM',  value: 4 },
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('export')
        .setDescription("Export one round's orders to a CSV file")
        .addIntegerOption(option =>
          option.setName('round').setDescription('Round number').setRequired(true)
            .addChoices(
              { name: 'Round 1 — Placement 8:45 AM', value: 1 },
              { name: 'Round 2 — Placement 11:45 AM', value: 2 },
              { name: 'Round 3 — Placement 2:45 PM',  value: 3 },
              { name: 'Round 4 — Placement 4:45 PM',  value: 4 },
            )
        )
    ),
  // /branding — merged: branding (customize), setnickname, renamechannel
  new SlashCommandBuilder()
    .setName('branding')
    .setDescription('Branding and display customization (Admin only)')
    .addSubcommand(sub =>
      sub.setName('customize')
        .setDescription('Change embed color, bot name, footer text')
    )
    .addSubcommand(sub =>
      sub.setName('nickname')
        .setDescription("Change the bot's display name in your server")
        .addStringOption(option => option.setName('nickname').setDescription('New nickname').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('channel')
        .setDescription('Rename the status channel to open or closed')
        .addStringOption(option =>
          option.setName('status')
            .setDescription('Set the channel name to open or closed')
            .setRequired(true)
            .addChoices(
              { name: '🟢 Open', value: 'open' },
              { name: '🔴 Closed', value: 'closed' }
            )
        )
    ),
  new SlashCommandBuilder()
    .setName('setprice')
    .setDescription('Change what your customers pay per entree (Admin only)')
    .addNumberOption(option => option.setName('standard').setDescription('Standard price per entree').setRequired(true))
    .addNumberOption(option => option.setName('bulk_price').setDescription('Discounted rate at a quantity you set').setRequired(false))
    .addIntegerOption(option => option.setName('bulk_threshold').setDescription('How many entrees to trigger bulk pricing').setRequired(false)),
  new SlashCommandBuilder()
    .setName('setpayment')
    .setDescription('Update your payment methods (Venmo, Zelle, etc.) (Admin only)'),
  new SlashCommandBuilder()
    .setName('toggle')
    .setDescription('Enable or disable ordering in your server (Admin only)'),
  new SlashCommandBuilder()
    .setName('forceconfirm')
    .setDescription('Manually confirm a payment if auto-detect missed it (Admin only)')
    .addStringOption(option => option.setName('order_id').setDescription('Order ID to confirm').setRequired(true)),
  new SlashCommandBuilder()
    .setName('removeorder')
    .setDescription('Remove a customer\'s order from the queue (Admin only)')
    .addStringOption(option => option.setName('order_id').setDescription('Order ID to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Block or unblock a customer (Admin only)')
    .addUserOption(option => option.setName('user').setDescription('User to block/unblock').setRequired(true)),
  new SlashCommandBuilder()
    .setName('announcements')
    .setDescription('Create a new announcement in a channel or via webhook (Admin only)')
    .addStringOption(option => option.setName('message').setDescription('The announcement message').setRequired(true))
    .addChannelOption(option => option.setName('channel').setDescription('The channel to send the announcement to').setRequired(false))
    .addStringOption(option => option.setName('webhook_url').setDescription('Alternatively, a webhook URL to send the announcement to').setRequired(false))
    .addStringOption(option => option.setName('title').setDescription('The title of the announcement').setRequired(false))
    .addStringOption(option => option.setName('image_url').setDescription('An optional image URL to include in the announcement').setRequired(false)),
  new SlashCommandBuilder()
    .setName('fulfillall')
    .setDescription('Mark all paid orders as fulfilled (Admin only)'),
  new SlashCommandBuilder()
    .setName('storestatus')
    .setDescription('Open or close the store for new orders (Admin only)'),
  new SlashCommandBuilder()
    .setName('format')
    .setDescription('Customize the order details format printed after payment confirmation (Admin only)'),
  new SlashCommandBuilder()
    .setName('setwebhook')
    .setDescription('Set the webhook URL and status channel for this server (Admin only)')
    .addStringOption(option =>
      option.setName('webhook_url')
        .setDescription('Discord webhook URL for order notifications')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('status_channel')
        .setDescription('Channel to rename for store open/close status (optional)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Simulate a full order flow — verifies webhook, fulfillment, and config (Admin only)'),
  new SlashCommandBuilder()
    .setName('credit')
    .setDescription('Add or remove store credit for a customer (Admin only)')
    .addUserOption(option => option.setName('user').setDescription('Customer to credit').setRequired(true))
    .addNumberOption(option => option.setName('amount').setDescription('Amount to add (use negative to subtract)').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('Reason for credit adjustment').setRequired(false)),
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('Send a direct message to a customer (Admin only)')
    .addUserOption(option => option.setName('user').setDescription('Customer to message').setRequired(true))
    .addStringOption(option => option.setName('message').setDescription('Message to send').setRequired(true)),
  new SlashCommandBuilder()
    .setName('formatorderfoodie')
    .setDescription('Parse a .txt order file and format it as a confirmed order (Admin only)')
    .addAttachmentOption(option =>
      option.setName('file')
        .setDescription('.txt file with orders to format')
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option.setName('template')
        .setDescription('Download an example input file template instead')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('hours')
    .setDescription("View today's queue schedule and which rounds are open, closed, or paused"),
].map(command => command.toJSON());

// Handle global errors to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Returns the PST UTC offset in minutes (e.g. -480 for PST, -420 for PDT)
function getPSTUtcOffsetMinutes(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date());
  const offsetStr = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
  const match = offsetStr.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) return -480;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (parseInt(match[2], 10) * 60 + (match[3] ? parseInt(match[3], 10) : 0));
}

// Maps US state abbreviations to IANA timezone — instant, no API call needed
const STATE_TIMEZONE: Record<string, string> = {
  // Eastern
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit',  NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', NC: 'America/New_York',
  OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', VT: 'America/New_York', VA: 'America/New_York',
  WV: 'America/New_York', DC: 'America/New_York',
  IN: 'America/Indiana/Indianapolis', KY: 'America/Kentucky/Louisville',
  // Central
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago',
  IA: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago',
  MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago',
  NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  WI: 'America/Chicago',
  // Mountain
  AZ: 'America/Phoenix', CO: 'America/Denver',   ID: 'America/Boise',
  MT: 'America/Denver',  NM: 'America/Denver',   UT: 'America/Denver',
  WY: 'America/Denver',
  // Pacific
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  // Alaska / Hawaii
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

// Resolves IANA timezone from US state abbreviation, falls back to PST
function resolveTimezoneFromState(stateAbbr: string): string {
  return STATE_TIMEZONE[stateAbbr.toUpperCase()] || 'America/Los_Angeles';
}

// Converts a PST time (hour, minute) to a formatted string in the target IANA timezone
function pstTimeToLocalLabel(hourPST: number, minutePST: number, targetTimezone: string): string {
  const pstOffsetMinutes = getPSTUtcOffsetMinutes();

  // Get today's PST date components
  const pstDateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date());
  const year  = Number(pstDateParts.find(p => p.type === 'year')?.value);
  const month = Number(pstDateParts.find(p => p.type === 'month')?.value) - 1;
  const day   = Number(pstDateParts.find(p => p.type === 'day')?.value);

  // Convert PST time → UTC
  const totalUtcMinutes = hourPST * 60 + minutePST - pstOffsetMinutes;
  const utcDayOffset = Math.floor(totalUtcMinutes / (24 * 60));
  const utcMinutesInDay = ((totalUtcMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const utcDate = new Date(Date.UTC(year, month, day + utcDayOffset, Math.floor(utcMinutesInDay / 60), utcMinutesInDay % 60));

  return new Intl.DateTimeFormat('en-US', {
    timeZone: targetTimezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(utcDate);
}

// Returns earliest pickup time in minutes from midnight PST for the currently active round
function getEarliestPickupMinutesPST(): number {
  const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const totalMinutes = nowPST.getHours() * 60 + nowPST.getMinutes();

  // [queueOpen, placement, earliestPickup] all in minutes from midnight PST
  const rounds = [
    { queueOpen: 6*60+45,  placement: 8*60+45,  earliestPickup: 9*60+30  }, // Round 1
    { queueOpen: 9*60+45,  placement: 11*60+45, earliestPickup: 12*60+30 }, // Round 2
    { queueOpen: 12*60+45, placement: 14*60+45, earliestPickup: 15*60+30 }, // Round 3
    { queueOpen: 14*60+45, placement: 16*60+45, earliestPickup: 17*60+30 }, // Round 4
  ];

  for (const round of rounds) {
    if (totalMinutes >= round.queueOpen && totalMinutes < round.placement) {
      return round.earliestPickup;
    }
  }
  // Between rounds or before first: use next upcoming round
  for (const round of rounds) {
    if (totalMinutes < round.placement) return round.earliestPickup;
  }
  // After all rounds: default to Round 1 next day
  return 9*60+30;
}

// Returns the PST minute equivalent of 10:30 PM in the given timezone
function getStoreClosePSTMinutes(userTimezone: string): number {
  const pstOffset = getPSTUtcOffsetMinutes(); // e.g. -480 (PST) or -420 (PDT)

  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: userTimezone,
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date());
  const offsetStr = tzParts.find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
  const match = offsetStr.match(/GMT([+-])(\d+)(?::(\d+))?/);
  const sign = match ? (match[1] === '+' ? 1 : -1) : -1;
  const userOffset = match ? sign * (parseInt(match[2], 10) * 60 + (match[3] ? parseInt(match[3], 10) : 0)) : -480;

  // 10:30 PM local → UTC → PST
  // UTC = 22:30 - userOffset  |  PST = UTC + pstOffset
  return (22 * 60 + 30) - userOffset + pstOffset;
}

function generatePickupTimeOptions(earliestMinutes: number, timezone: string = 'America/Los_Angeles'): { label: string; value: string }[] {
  const storeClose = getStoreClosePSTMinutes(timezone); // 10:30 PM in customer's local timezone
  const options: { label: string; value: string }[] = [];
  for (let m = earliestMinutes; m <= storeClose; m += 15) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const label = pstTimeToLocalLabel(h, min, timezone);
    options.push({ label, value: label });
  }
  return options;
}

async function showPickupTimeSelect(interaction: any, state: any) {
  // Acknowledge the interaction before any async work to stay within Discord's 3-second window
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isStringSelectMenu() || interaction.isButton()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  }

  const userTimezone: string = state.info?.timezone || 'America/Los_Angeles';
  const earliestMinutes = state.isManual ? 11 * 60 : getEarliestPickupMinutesPST();

  const options = generatePickupTimeOptions(earliestMinutes, userTimezone);
  const earliestStr = options[0]?.label ?? pstTimeToLocalLabel(Math.floor(earliestMinutes / 60), earliestMinutes % 60, userTimezone);

  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (options.length <= 25) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('pickup_time_select')
        .setPlaceholder('🕐 Select your pickup time')
        .addOptions(options)
    ));
  } else {
    // Split into 25-option chunks (Discord max per select menu)
    const chunks: typeof options[] = [];
    for (let i = 0; i < options.length; i += 25) {
      chunks.push(options.slice(i, i + 25));
    }
    chunks.forEach((chunk, idx) => {
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`pickup_time_select_${idx + 1}`)
          .setPlaceholder(`🕐 ${chunk[0]?.label} — ${chunk[chunk.length - 1]?.label}`)
          .addOptions(chunk)
      ));
    });
  }

  await interaction.editReply({
    content: `🕐 **Select your pickup time**\nEarliest available for this round: **${earliestStr}**`,
    components: rows,
    embeds: []
  });
}

async function showOrderModal(interaction: any) {
  const modal = new ModalBuilder()
    .setCustomId('order_info_modal')
    .setTitle('Chipotle Order — Contact Info');

  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Name on Order')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const locationInput = new TextInputBuilder()
    .setCustomId('zipcode')
    .setLabel('Zip Code (to find nearby Chipotle)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 90210')
    .setRequired(true);

  const phoneInput = new TextInputBuilder()
    .setCustomId('phone')
    .setLabel('Phone Number')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const emailInput = new TextInputBuilder()
    .setCustomId('email')
    .setLabel('Email (Gmail Only)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('user@gmail.com')
    .setRequired(true);

  const entreesInput = new TextInputBuilder()
    .setCustomId('entrees')
    .setLabel('Number of Entrees (1–8)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 2')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(nameInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(locationInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(phoneInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(emailInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(entreesInput)
  );

  await interaction.showModal(modal);
}

async function initDiscordBot() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.error('❌ CRITICAL ERROR: DISCORD_TOKEN or DISCORD_CLIENT_ID is missing.');
    console.error('Please set these in the Secrets/Environment Variables menu to start the bot.');
    return;
  }
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Successfully reloaded application (/) commands.');

    client.once(Events.ClientReady, async c => {
      const config = await getBotConfig() || {};
      if (config.statusMessage) {
        c.user.setActivity(config.statusMessage);
      }

      // Set bot avatar from logo file (only if not already set via branding config)
      if (!config.avatarUrl && fs.existsSync(LOGO_PATH)) {
        try {
          await c.user.setAvatar(fs.readFileSync(LOGO_PATH));
          console.log('✅ Bot avatar set from logo.png');
        } catch (e: any) {
          // Rate limit is 2 avatar changes per hour — silently skip if limited
          console.warn('⚠️  Could not set bot avatar:', e.message);
        }
      }
      const guildCount = c.guilds.cache.size;
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const tag = c.user.tag;
      const id  = c.user.id;
      // ── Matrix-style boot banner ──────────────────────────────────────────
      const G  = '\x1b[32m';    // matrix green
      const BG = '\x1b[92m';    // bright green
      const DG = '\x1b[2;32m';  // dim green
      const WH = '\x1b[97m';    // white
      const DW = '\x1b[2;37m';  // dim white
      const R  = '\x1b[0m';     // reset
      const B  = '\x1b[1m';     // bold

      const logo = [
        `${BG} ██████╗ ██╗   ██╗██████╗ ██████╗ ██╗████████╗ ██████╗ ${R}`,
        `${BG} ██╔══██╗██║   ██║██╔══██╗██╔══██╗██║╚══██╔══╝██╔═══██╗${R}`,
        `${G}  ██████╔╝██║   ██║██████╔╝██████╔╝██║   ██║   ██║   ██║${R}`,
        `${G}  ██╔══██╗██║   ██║██╔══██╗██╔══██╗██║   ██║   ██║   ██║${R}`,
        `${DG} ██████╔╝╚██████╔╝██║  ██║██║  ██║██║   ██║   ╚██████╔╝${R}`,
        `${DG} ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝   ╚═╝    ╚═════╝ ${R}`,
        `${DG}                                                           ${R}`,
        `${DG}  ██████╗  ██████╗ ████████╗                              ${R}`,
        `${G}  ██╔══██╗██╔═══██╗╚══██╔══╝                              ${R}`,
        `${G}  ██████╔╝██║   ██║   ██║                                 ${R}`,
        `${BG} ██╔══██╗██║   ██║   ██║                                 ${R}`,
        `${BG} ██████╔╝╚██████╔╝   ██║                                 ${R}`,
        `${BG} ╚═════╝  ╚═════╝    ╚═╝                                 ${R}`,
      ];

      // randomised matrix rain header
      const rainChars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノ';
      const rainLine = (len: number) =>
        Array.from({ length: len }, () =>
          Math.random() > 0.6
            ? `${BG}${rainChars[Math.floor(Math.random() * rainChars.length)]}${R}`
            : `${DG}${rainChars[Math.floor(Math.random() * rainChars.length)]}${R}`
        ).join('');

      const w = 56;
      const bar   = `${DG}${'─'.repeat(w)}${R}`;
      const field = (label: string, val: string) =>
        `  ${DG}${label.padEnd(10)}${R}${G}${val}${R}`;

      console.log('');
      console.log(`  ${DG}${rainLine(w)}${R}`);
      console.log(`  ${DG}${rainLine(w)}${R}`);
      console.log('');
      logo.forEach(l => console.log(` ${l}`));
      console.log('');
      console.log(`  ${bar}`);
      console.log(field('TAG',      tag));
      console.log(field('ID',       id));
      console.log(field('SERVERS',  String(guildCount)));
      console.log(field('UPLINK',   now));
      console.log(field('STATUS',   config.statusMessage || 'NOMINAL'));
      console.log(field('DASH',     `http://localhost:${process.env.PORT || 3000}`));
      console.log(`  ${bar}`);
      console.log(`  ${BG}${B}  [ SYSTEM ONLINE — AWAITING ORDERS ]${R}`);
      console.log(`  ${DG}${rainLine(w)}${R}`);
      console.log('');
    });

    // Register Interaction Handler
    client.on(Events.InteractionCreate, async interaction => {
      try {
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'schedule') {
            const config = await getGuildConfig(interaction.guildId!) || {};
            const embed = createEmbed(config)
              .setTitle('🗓️ Queue Schedule & Rules')
              .setDescription(QUEUE_SCHEDULE_TEXT);
            return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          }

          if (interaction.commandName === 'order') {
            const config = await getGuildConfig(interaction.guildId!) || {};
            if (config.storeOpen === false) {
              return await interaction.reply({ content: '❌ **The store is currently closed.** We are not accepting new orders at this time.', flags: MessageFlags.Ephemeral });
            }

            // Check if the current round is paused
            const pausedRounds: number[] = config.pausedRounds || [];
            const activeRoundNum = getActiveRoundNumber();
            if (activeRoundNum !== null && pausedRounds.includes(activeRoundNum)) {
              return await interaction.reply({ content: `⏸️ **Round ${activeRoundNum} is currently paused.** Please check back when the next round opens. Use \`/hours\` to see the schedule.`, flags: MessageFlags.Ephemeral });
            }

            // Check if user is blacklisted in this server
            try {
              const blacklistDoc = await db.collection('guilds').doc(interaction.guildId!).collection('blacklist').doc(interaction.user.id).get();
              if (blacklistDoc.exists) {
                return await interaction.reply({ content: '❌ You have been blocked from placing orders. Please contact an admin if you believe this is an error.', flags: MessageFlags.Ephemeral });
              }
            } catch (e) {
              console.error('Error checking blacklist:', e);
            }

            // Show schedule info before modal
            const scheduleEmbed = createEmbed(config)
              .setTitle('🗓️ Before You Order — Queue Info')
              .setDescription(QUEUE_SCHEDULE_TEXT);
            const startBtn = new ButtonBuilder()
              .setCustomId('start_order_modal')
              .setLabel('🛒 Place My Order')
              .setStyle(ButtonStyle.Success);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(startBtn);
            return await interaction.reply({ embeds: [scheduleEmbed], components: [row], flags: MessageFlags.Ephemeral });
          }

          // (order modal is shown via start_order_modal button — see button handler below)

          if (interaction.commandName === 'setup') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
            }
            const setupSub = (interaction.options as any).getSubcommand();

            if (setupSub === 'config') {
              const config = await getGuildConfig(interaction.guildId!) || {};

              const modal = new ModalBuilder()
                .setCustomId('config_modal')
                .setTitle('Bot Message Configuration');

              const welcomeInput = new TextInputBuilder()
                .setCustomId('welcomeMessage')
                .setLabel('Welcome Message')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(config.welcomeMessage || 'Great! Now choose your entree:')
                .setRequired(false);

              const entreeInput = new TextInputBuilder()
                .setCustomId('entreePrompt')
                .setLabel('Entree Selection Prompt')
                .setStyle(TextInputStyle.Short)
                .setValue(config.entreePrompt || 'Choose your entree:')
                .setRequired(false);

              const proteinInput = new TextInputBuilder()
                .setCustomId('proteinPrompt')
                .setLabel('Protein Selection Prompt')
                .setStyle(TextInputStyle.Short)
                .setValue(config.proteinPrompt || 'Now choose your protein:')
                .setRequired(false);

              const checkoutInput = new TextInputBuilder()
                .setCustomId('checkoutMessage')
                .setLabel('Checkout Instructions')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(config.checkoutMessage || 'Please pay using the link below. Your order will be sent to the kitchen automatically once payment is confirmed.')
                .setRequired(false);

              const successInput = new TextInputBuilder()
                .setCustomId('successMessage')
                .setLabel('Success Confirmation')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(config.successMessage || '✅ Payment confirmed! Your order has been sent to the kitchen.')
                .setRequired(false);

              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(welcomeInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(entreeInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(proteinInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(checkoutInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(successInput)
              );

              await interaction.showModal(modal);
            } else if (setupSub === 'settings') {
              await handleSettings(interaction);
            } else if (setupSub === 'main') {
              await handleSetup(interaction);
            }
          }

          if (interaction.commandName === 'reorder') {
            await handleReorder(interaction);
          }

          if (interaction.commandName === 'myorders') {
            await handleMyOrders(interaction);
          }

          if (interaction.commandName === 'menu') {
            await handleMenu(interaction);
          }

          if (interaction.commandName === 'wallet') {
            await handleWallet(interaction);
          }

          if (interaction.commandName === 'deposit') {
            await handleDeposit(interaction);
          }

          if (interaction.commandName === 'support') {
            await handleSupport(interaction);
          }

          if (interaction.commandName === 'help') {
            await handleHelp(interaction);
          }

          if (interaction.commandName === 'hours') {
            await handleHours(interaction);
          }

          if (interaction.commandName === 'payment') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
            }
            const paymentSub = (interaction.options as any).getSubcommand();

            if (paymentSub === 'cashapp') {
              // Show a prompt to guide the user to the cashapp subcommands (tag, setcookie, login are no longer top-level)
              // For backward compat we open the Cash App tag/cookie setup menu
              const chromePath = findChromePath();
              const embed = createEmbed(await getGuildConfig(interaction.guildId!) || {})
                .setTitle('Cash App Setup')
                .setDescription([
                  'Use the following subcommands to configure Cash App:',
                  '• `/payment cashapp` — this help panel',
                  '',
                  'To set your $cashtag, use `/setpayment` or re-run with the tag option.',
                  chromePath
                    ? '🌐 Chrome detected — you can use the browser login flow via `/payment cashapp` (cookie capture).'
                    : '🍪 Chrome not found — paste your `cash_web_session` cookie manually via `/payment setup`.',
                ].join('\n'));
              return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            if (paymentSub === 'zelle') {
              const config = await getGuildConfig(interaction.guildId!) || {};
              const modal = new ModalBuilder()
                .setCustomId('zelle_credentials_modal')
                .setTitle('Zelle Email Credentials — This Server Only');
              const emailInput = new TextInputBuilder()
                .setCustomId('zelle_imap_email')
                .setLabel('Email address (Gmail, Outlook, Yahoo…)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('you@gmail.com');
              if (config.zelleImapEmail) emailInput.setValue(config.zelleImapEmail);
              const passInput = new TextInputBuilder()
                .setCustomId('zelle_imap_password')
                .setLabel('App Password (not your regular password)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('xxxx xxxx xxxx xxxx');
              const hostInput = new TextInputBuilder()
                .setCustomId('zelle_imap_host')
                .setLabel('IMAP host (leave blank to auto-detect)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setPlaceholder('imap.gmail.com  /  outlook.office365.com');
              if (config.zelleImapHost) hostInput.setValue(config.zelleImapHost);
              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(emailInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(passInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(hostInput),
              );
              return await interaction.showModal(modal);
            }

            if (paymentSub === 'setup') {
              const cfg = await getGuildConfig(interaction.guildId!) || {};
              const modal = new ModalBuilder()
                .setCustomId('payment_email_modal')
                .setTitle('Payment Email Setup — This Server Only');
              const emailInput = new TextInputBuilder()
                .setCustomId('payment_imap_email')
                .setLabel('Email address (Gmail, Outlook, Yahoo…)')
                .setStyle(TextInputStyle.Short).setRequired(true)
                .setPlaceholder('you@gmail.com');
              if (cfg.paymentImapEmail) emailInput.setValue(cfg.paymentImapEmail);
              const passInput = new TextInputBuilder()
                .setCustomId('payment_imap_password')
                .setLabel('App Password (not your regular password)')
                .setStyle(TextInputStyle.Short).setRequired(true)
                .setPlaceholder('xxxx xxxx xxxx xxxx');
              const hostInput = new TextInputBuilder()
                .setCustomId('payment_imap_host')
                .setLabel('IMAP host (leave blank to auto-detect)')
                .setStyle(TextInputStyle.Short).setRequired(false)
                .setPlaceholder('imap.gmail.com');
              if (cfg.paymentImapHost) hostInput.setValue(cfg.paymentImapHost);
              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(emailInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(passInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(hostInput),
              );
              return await interaction.showModal(modal);
            }

            if (paymentSub === 'test') {
              const cfg = await getGuildConfig(interaction.guildId!) || {};
              if (!cfg.paymentImapEmail || !cfg.paymentImapPassword) {
                return await interaction.reply({ content: '❌ No payment email saved. Run `/payment setup` first.', flags: MessageFlags.Ephemeral });
              }
              await interaction.reply({ content: '🔌 Testing connection…', flags: MessageFlags.Ephemeral });
              try {
                await testPaymentEmail({ email: cfg.paymentImapEmail, password: cfg.paymentImapPassword, host: cfg.paymentImapHost });
                await interaction.editReply({ content: '✅ Connection successful! Email payment verification is active for Cash App, Venmo, Zelle, and PayPal.' });
              } catch (err: any) {
                await interaction.editReply({ content: `❌ Connection failed: ${err.message}` });
              }
            }

            if (paymentSub === 'clear') {
              const cfg = await getGuildConfig(interaction.guildId!) || {};
              const updates: any = { ...cfg };
              delete updates.paymentImapEmail;
              delete updates.paymentImapPassword;
              delete updates.paymentImapHost;
              await updateGuildConfig(interaction.guildId!, updates);
              return await interaction.reply({ content: '✅ Payment email credentials removed.', flags: MessageFlags.Ephemeral });
            }

            if (paymentSub === 'verify') {
              const vpCfg = await getGuildConfig(interaction.guildId!) || {};
              if (!vpCfg.paymentImapEmail || !vpCfg.paymentImapPassword) {
                return await interaction.reply({ content: '❌ No payment email saved. Run `/payment setup` first.', flags: MessageFlags.Ephemeral });
              }
              const provider = (interaction.options as any).getString('provider') as import('./email-payments.ts').PaymentProvider;
              const amount   = (interaction.options as any).getNumber('amount') as number;
              const orderId  = (interaction.options as any).getString('order_id') as string | null;
              const lookback = (interaction.options as any).getInteger('lookback') ?? 45;
              await interaction.reply({ content: '🔍 Scanning inbox…', flags: MessageFlags.Ephemeral });
              try {
                const result = await inspectLatestPaymentEmail(
                  { email: vpCfg.paymentImapEmail, password: vpCfg.paymentImapPassword, host: vpCfg.paymentImapHost },
                  provider,
                  amount,
                  lookback,
                );
                if (!result) {
                  return await interaction.editReply({ content: `❌ No matching payment email found in the last ${lookback} minutes.` });
                }
                const amtList  = result.amountsFound.length ? result.amountsFound.map(a => `**$${a.toFixed(2)}**`).join(', ') : '_none_';
                const memoLine = result.memo ? `**Memo/Note:** ${result.memo}` : '**Memo/Note:** _not found_';

                let verdict = result.matched ? '✅ Would be verified' : '❌ Would NOT verify';
                let reason  = result.matchReason;
                if (orderId && result.memo) {
                  const memoHasId = result.memo.toLowerCase().includes(orderId.toLowerCase());
                  reason += memoHasId ? ` | Memo contains order ID ✅` : ` | Memo does NOT contain order ID ❌`;
                }
                const matchLine = `**Match:** ${verdict} — ${reason}`;
                const snippetLine = result.bodySnippet ? `**Body (first 400 chars):**\n\`\`\`\n${result.bodySnippet}\n\`\`\`` : '';

                const lines = [
                  `**Payment Verification — last ${lookback} min**`,
                  `**UID:** \`${result.uid}\``,
                  `**From:** ${result.from}`,
                  `**Subject:** ${result.subject}`,
                  `**Date:** ${result.date}`,
                  `**Provider:** ${result.provider}`,
                  `**Amounts Parsed:** ${amtList}`,
                  memoLine,
                  matchLine,
                  snippetLine,
                ].filter(Boolean).join('\n');
                await interaction.editReply({ content: lines });
              } catch (err: any) {
                await interaction.editReply({ content: `❌ Error scanning inbox: ${err.message}` });
              }
            }
          }

          if (interaction.commandName === 'manualorder') {
            await handleManualOrder(interaction);
          }

          const adminCommands = ['setprice', 'setpayment', 'toggle', 'blacklist', 'announcements', 'fulfillall', 'storestatus', 'format', 'setwebhook', 'test', 'credit', 'dm', 'formatorderfoodie', 'report', 'round', 'branding'];
          const staffCommands = ['orders', 'forceconfirm', 'removeorder'];

          if (adminCommands.includes(interaction.commandName) || staffCommands.includes(interaction.commandName)) {
            const config = await getGuildConfig(interaction.guildId!) || {};
            const isStaff = config.staffRoleId && interaction.member?.roles && (interaction.member.roles as any).cache.has(config.staffRoleId);
            const isAdmin = interaction.memberPermissions?.has('Administrator');

            if (adminCommands.includes(interaction.commandName) && !isAdmin) {
              return await interaction.reply({ content: '❌ You must be an Administrator to use this command.', flags: MessageFlags.Ephemeral });
            }

            if (staffCommands.includes(interaction.commandName) && !isAdmin && !isStaff) {
              return await interaction.reply({ content: '❌ You must be Staff or an Administrator to use this command.', flags: MessageFlags.Ephemeral });
            }

            if (interaction.commandName === 'orders') {
              const ordersSub = (interaction.options as any).getSubcommand();
              if (ordersSub === 'view') {
                await showAdminOrders(interaction, 'pending');
              } else if (ordersSub === 'pending') {
                if (!isAdmin) {
                  return await interaction.reply({ content: '❌ You must be an Administrator to use this subcommand.', flags: MessageFlags.Ephemeral });
                }
                await handlePending(interaction);
              } else if (ordersSub === 'manage') {
                if (!isAdmin) {
                  return await interaction.reply({ content: '❌ You must be an Administrator to use this subcommand.', flags: MessageFlags.Ephemeral });
                }
                await showAdminOrders(interaction, 'pending');
              } else if (ordersSub === 'batch') {
                if (!isAdmin) {
                  return await interaction.reply({ content: '❌ You must be an Administrator to use this subcommand.', flags: MessageFlags.Ephemeral });
                }
                await showAdminBatch(interaction);
              }
            } else if (interaction.commandName === 'history') {
              await showAdminOrders(interaction, 'paid_fulfilled');
            } else if (interaction.commandName === 'forceconfirm') {
              const orderId = interaction.options.getString('order_id');
              if (orderId) {
                // Check if it's a deposit first
                const depositDoc = await db.collection('guilds').doc(interaction.guildId!).collection('deposits').doc(orderId).get();
                if (depositDoc.exists) {
                  const depositData = depositDoc.data()!;
                  if (depositData.status === 'confirmed') {
                    return await interaction.reply({ content: '❌ This deposit has already been confirmed.', flags: MessageFlags.Ephemeral });
                  }
                  const depositUserId: string = depositData.userId;
                  const depositAmount: number = depositData.amount;
                  const customerRef = db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(depositUserId);
                  await db.runTransaction(async (txn) => {
                    const doc = await txn.get(customerRef);
                    const bal: number = doc.exists ? (doc.data()?.creditBalance || 0) : 0;
                    const newBal = Math.round((bal + depositAmount) * 100) / 100;
                    txn.set(customerRef, { userId: depositUserId, creditBalance: newBal, lastCreditReason: `Deposit ${orderId}`, lastCreditAdjustment: serverTimestamp() }, { merge: true });
                  });
                  await depositDoc.ref.update({ status: 'confirmed' });
                  try {
                    const customerDoc2 = await customerRef.get();
                    const finalBal: number = customerDoc2.data()?.creditBalance || 0;
                    const targetUser = await client.users.fetch(depositUserId);
                    const dm = await targetUser.createDM();
                    await dm.send(`✅ **${interaction.guild?.name}**: Your deposit of **$${depositAmount.toFixed(2)}** was confirmed! Your wallet balance is now **$${finalBal.toFixed(2)}**.`);
                  } catch {}
                  return await interaction.reply({ content: `✅ Deposit \`${orderId}\` ($${depositAmount.toFixed(2)}) manually confirmed.`, flags: MessageFlags.Ephemeral });
                }
                // Otherwise treat as an order
                const orderDoc = await db.collection('orders').doc(orderId).get();
                if (!orderDoc.exists || orderDoc.data()?.guildId !== interaction.guildId) {
                  return await interaction.reply({ content: '❌ Order or deposit not found in this server.', flags: MessageFlags.Ephemeral });
                }
                await fulfillOrder(orderId);
                await interaction.reply({ content: `✅ Order ${orderId} manually confirmed.`, flags: MessageFlags.Ephemeral });
              }
            } else if (interaction.commandName === 'removeorder') {
              const orderId = interaction.options.getString('order_id');
              if (orderId) {
                const orderDoc = await db.collection('orders').doc(orderId).get();
                if (!orderDoc.exists || orderDoc.data()?.guildId !== interaction.guildId) {
                  return await interaction.reply({ content: '❌ Order not found in this server.', flags: MessageFlags.Ephemeral });
                }
                await db.collection('orders').doc(orderId).update({ status: 'cancelled' });
                await interaction.reply({ content: `✅ Order ${orderId} cancelled.`, flags: MessageFlags.Ephemeral });
              }
            } else if (interaction.commandName === 'setprice') {
              await handleSetPrice(interaction);
            } else if (interaction.commandName === 'setpayment') {
              await handleSetPayment(interaction);
            } else if (interaction.commandName === 'branding') {
              const brandingSub = (interaction.options as any).getSubcommand();
              if (brandingSub === 'customize') {
                await handleBranding(interaction);
              } else if (brandingSub === 'nickname') {
                const nickname = interaction.options.getString('nickname');
                try {
                  if (interaction.guild?.members.me) {
                    await interaction.guild.members.me.setNickname(nickname);
                    await interaction.reply({ content: `✅ Bot nickname changed to **${nickname}**.`, flags: MessageFlags.Ephemeral });
                  } else {
                    await interaction.reply({ content: '❌ Could not change nickname.', flags: MessageFlags.Ephemeral });
                  }
                } catch (e) {
                  await interaction.reply({ content: '❌ Missing permissions to change nickname.', flags: MessageFlags.Ephemeral });
                }
              } else if (brandingSub === 'channel') {
                await handleRenameChannel(interaction);
              }
            } else if (interaction.commandName === 'toggle') {
              await handleToggle(interaction);
            } else if (interaction.commandName === 'blacklist') {
              await handleBlacklist(interaction);
            } else if (interaction.commandName === 'announcements') {
              await handleAnnouncements(interaction);
            } else if (interaction.commandName === 'fulfillall') {
              await handleFulfillAll(interaction);
            } else if (interaction.commandName === 'storestatus') {
              await handleStoreStatus(interaction);
            } else if (interaction.commandName === 'report') {
              const reportSub = (interaction.options as any).getSubcommand();
              if (reportSub === 'revenue') {
                await handleRevenue(interaction);
              } else if (reportSub === 'history') {
                await showAdminOrders(interaction, 'paid_fulfilled');
              } else if (reportSub === 'stats') {
                await handleStats(interaction);
              } else if (reportSub === 'customers') {
                await handleCustomers(interaction);
              } else if (reportSub === 'export') {
                await handleExport(interaction);
              }
            } else if (interaction.commandName === 'format') {
              await handleFormat(interaction);
            } else if (interaction.commandName === 'setwebhook') {
              await handleSetWebhook(interaction);
            } else if (interaction.commandName === 'test') {
              await handleTest(interaction);
            } else if (interaction.commandName === 'credit') {
              await handleCredit(interaction);
            } else if (interaction.commandName === 'round') {
              const roundSub = (interaction.options as any).getSubcommand();
              if (roundSub === 'pause') {
                await handlePause(interaction);
              } else if (roundSub === 'summary') {
                await handleRoundSummary(interaction);
              } else if (roundSub === 'export') {
                await handleExportRound(interaction);
              }
            } else if (interaction.commandName === 'dm') {
              await handleDm(interaction);
            } else if (interaction.commandName === 'formatorderfoodie') {
              await handleFormatOrderFoodie(interaction);
            } else {
              await interaction.reply({ content: `🛠️ Command \`/${interaction.commandName}\` is under construction.`, flags: MessageFlags.Ephemeral });
            }
          }


        }

        if (interaction.type === InteractionType.ModalSubmit) {
          if (interaction.customId === 'payment_email_modal') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ Administrators only.', flags: MessageFlags.Ephemeral });
            }
            const paymentImapEmail    = interaction.fields.getTextInputValue('payment_imap_email').trim();
            const paymentImapPassword = interaction.fields.getTextInputValue('payment_imap_password').trim();
            const paymentImapHost     = interaction.fields.getTextInputValue('payment_imap_host').trim() || undefined;
            if (!paymentImapEmail || !paymentImapPassword) {
              return await interaction.reply({ content: '❌ Email and password are required.', flags: MessageFlags.Ephemeral });
            }
            await interaction.reply({ content: '🔌 Saving and testing connection…', flags: MessageFlags.Ephemeral });
            try {
              await testPaymentEmail({ email: paymentImapEmail, password: paymentImapPassword, host: paymentImapHost });
            } catch (err: any) {
              return await interaction.editReply({ content: `❌ Connection test failed: ${err.message}\n\nCredentials were NOT saved.` });
            }
            const cfg2 = await getGuildConfig(interaction.guildId!) || {};
            const upd: any = { ...cfg2, paymentImapEmail, paymentImapPassword };
            if (paymentImapHost) upd.paymentImapHost = paymentImapHost;
            const ok = await updateGuildConfig(interaction.guildId!, upd);
            if (ok) {
              await interaction.editReply({ content: '✅ Payment email saved and verified. Auto-verification is now active for Cash App, Venmo, Zelle, and PayPal.' });
            } else {
              await interaction.editReply({ content: '❌ Connection verified but failed to save. Try again.' });
            }
            return;
          }

          if (interaction.customId === 'zelle_credentials_modal') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ Administrators only.', flags: MessageFlags.Ephemeral });
            }
            const zelleImapEmail    = interaction.fields.getTextInputValue('zelle_imap_email').trim();
            const zelleImapPassword = interaction.fields.getTextInputValue('zelle_imap_password').trim();
            const zelleImapHost     = interaction.fields.getTextInputValue('zelle_imap_host').trim() || undefined;
            if (!zelleImapEmail || !zelleImapPassword) {
              return await interaction.reply({ content: '❌ Email and password are required.', flags: MessageFlags.Ephemeral });
            }
            await interaction.reply({ content: '🔌 Saving and testing connection…', flags: MessageFlags.Ephemeral });
            try {
              await testZelleConnection({ email: zelleImapEmail, password: zelleImapPassword, host: zelleImapHost });
            } catch (err: any) {
              return await interaction.editReply({ content: `❌ Connection test failed: ${err.message}\n\nCredentials were NOT saved.` });
            }
            const config = await getGuildConfig(interaction.guildId!) || {};
            const updates: any = { ...config, zelleImapEmail, zelleImapPassword };
            if (zelleImapHost) updates.zelleImapHost = zelleImapHost;
            const success = await updateGuildConfig(interaction.guildId!, updates);
            if (success) {
              await interaction.editReply({ content: '✅ Zelle credentials saved and connection verified. Auto-verification is now active.' });
            } else {
              await interaction.editReply({ content: '❌ Connection verified but failed to save credentials. Try again.' });
            }
            return;
          }

          if (interaction.customId === 'cashapp_cookie_modal') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ Administrators only.', flags: MessageFlags.Ephemeral });
            }
            const rawCookie = interaction.fields.getTextInputValue('cashapp_cookie_value').trim();
            if (!rawCookie) {
              return await interaction.reply({ content: '❌ Cookie value cannot be empty.', flags: MessageFlags.Ephemeral });
            }
            const config = await getGuildConfig(interaction.guildId!) || {};
            const success = await updateGuildConfig(interaction.guildId!, { ...config, cashappCookie: rawCookie });
            if (success) {
              await interaction.reply({
                content: '✅ Cash App cookie saved for this server. Auto-verification is now active.',
                flags: MessageFlags.Ephemeral,
              });
            } else {
              await interaction.reply({ content: '❌ Failed to save cookie. Check server logs.', flags: MessageFlags.Ephemeral });
            }
            return;
          }

          if (interaction.customId === 'manual_info_modal') {
            const rawPhone = interaction.fields.getTextInputValue('manual_phone');
            if (!/^[+]?[\d\s()\-]{7,20}$/.test(rawPhone)) {
              return await interaction.reply({ content: '❌ Please enter a valid phone number.', flags: MessageFlags.Ephemeral });
            }
            const zipCode = interaction.fields.getTextInputValue('manual_zipcode').replace(/\D/g, '').slice(0, 5);
            if (!/^\d{5}$/.test(zipCode)) {
              return await interaction.reply({ content: '❌ Please enter a valid 5-digit US zip code.', flags: MessageFlags.Ephemeral });
            }
            const rawEntrees = interaction.fields.getTextInputValue('manual_entrees').trim();
            const parsedEntrees = parseInt(rawEntrees, 10);
            if (isNaN(parsedEntrees) || parsedEntrees < 1 || parsedEntrees > 9) {
              return await interaction.reply({ content: '❌ Please enter a number of entrees between 1 and 9.', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // Convert zip to coordinates
            let lat: number, lng: number, cityName: string, stateAbbr: string;
            try {
              const geoRes = await fetch(`https://api.zippopotam.us/us/${zipCode}`);
              if (!geoRes.ok) throw new Error('Zip not found');
              const geoData: any = await geoRes.json();
              if (!geoData.places || geoData.places.length === 0) throw new Error('No places returned for zip');
              lat = parseFloat(geoData.places[0].latitude);
              lng = parseFloat(geoData.places[0].longitude);
              stateAbbr = geoData.places[0]['state abbreviation'];
              cityName = `${geoData.places[0]['place name']}, ${stateAbbr}`;
            } catch (e) {
              return await interaction.editReply({ content: '❌ Could not find that zip code. Please enter a valid US zip code.' });
            }

            const distMiles = (lat1: number, lon1: number, lat2: number, lon2: number) => {
              const R = 3958.8;
              const dLat = (lat2 - lat1) * Math.PI / 180;
              const dLon = (lon2 - lon1) * Math.PI / 180;
              const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
              return R * 2 * Math.asin(Math.sqrt(a));
            };

            const toStore = (elLat: number, elLon: number, tags: any) => ({
              _lat: elLat, _lon: elLon,
              _miles: distMiles(lat, lng, elLat, elLon),
              name: tags.name || 'Chipotle',
              houseNumber: tags['addr:housenumber'] || '',
              street: tags['addr:street'] || '',
              city: tags['addr:city'] || '',
              stateTag: tags['addr:state'] || '',
              postcode: tags['addr:postcode'] || ''
            });

            const fetchMapTiler = async (): Promise<any[]> => {
              const res = await fetch(`https://api.maptiler.com/geocoding/Chipotle%20Mexican%20Grill.json?proximity=${lng},${lat}&limit=10&types=poi&key=MDqZ9Tw4PuuEnadIszzz`);
              if (!res.ok) throw new Error('MapTiler error');
              const data: any = await res.json();
              const results = (data.features || []).map((f: any) => {
                const [fLon, fLat] = f.geometry?.coordinates || [0, 0];
                const tags = f.properties?.feature_tags || {};
                return { _lat: fLat, _lon: fLon, _miles: distMiles(lat, lng, fLat, fLon), name: f.text || 'Chipotle', houseNumber: tags['addr:housenumber'] || '', street: tags['addr:street'] || '', city: tags['addr:city'] || '', stateTag: tags['addr:state'] || '', postcode: tags['addr:postcode'] || '' };
              }).filter((s: any) => s._miles <= 25).sort((a: any, b: any) => a._miles - b._miles).slice(0, 5);
              if (results.length === 0) throw new Error('No MapTiler results');
              return results;
            };

            const fetchOverpass = async (): Promise<any[]> => {
              const radiusMeters = 40234;
              const query = `[out:json][timeout:15];(node["name"~"Chipotle",i](around:${radiusMeters},${lat},${lng});way["name"~"Chipotle",i](around:${radiusMeters},${lat},${lng}););out center;`;
              const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
              if (!res.ok) throw new Error('Overpass error');
              const data: any = await res.json();
              const results = (data.elements || [])
                .filter((e: any) => (e.lat ?? e.center?.lat) != null && (e.lon ?? e.center?.lon) != null)
                .map((e: any) => toStore(e.lat ?? e.center?.lat, e.lon ?? e.center?.lon, e.tags || {}))
                .sort((a: any, b: any) => a._miles - b._miles).slice(0, 5);
              if (results.length === 0) throw new Error('No Overpass results');
              return results;
            };

            let stores: any[] = [];
            try {
              stores = await Promise.any([fetchMapTiler(), fetchOverpass()]);
            } catch (e) {
              return await interaction.editReply({ content: '❌ Could not retrieve Chipotle locations. Please try again.' });
            }
            if (stores.length === 0) {
              return await interaction.editReply({ content: `❌ No Chipotle locations found within 25 miles of **${zipCode}**. Try a nearby zip code.` });
            }

            const timezone = resolveTimezoneFromState(stateAbbr!);
            const maxEntrees = parsedEntrees;
            orderState.set(`${interaction.user.id}:${interaction.guildId}`, {
              guildId: interaction.guildId,
              maxEntrees,
              isManual: true,
              info: {
                name: sanitizeInput(interaction.fields.getTextInputValue('manual_name'), 100),
                location: '',
                time: '',
                phone: sanitizeInput(rawPhone, 20),
                email: sanitizeInput(interaction.fields.getTextInputValue('manual_email'), 100),
                lat, lng, timezone,
              },
              orders: [],
              editingIndex: null,
              lastUpdated: Date.now(),
            });

            const storeSelect = new StringSelectMenuBuilder()
              .setCustomId('store_select')
              .setPlaceholder('📍 Select your Chipotle location')
              .addOptions(stores.map((store: any, idx: number) => {
                const streetAddr = `${store.houseNumber} ${store.street}`.trim();
                const fullAddress = `${streetAddr}, ${store.city}, ${store.stateTag} ${store.postcode}`.trim().replace(/^,\s*/, '');
                const miles = store._miles.toFixed(1);
                const value = `${idx}:${(fullAddress || `${store._lat},${store._lon}`)}`.slice(0, 100);
                return { label: (streetAddr || store.city || 'Chipotle').slice(0, 100), description: `${store.city}, ${store.stateTag} ${store.postcode} — ${miles} mi away`.slice(0, 100), value };
              }));
            const storeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(storeSelect);
            await interaction.editReply({ content: `📍 Found **${stores.length}** Chipotle location(s) near **${cityName} ${zipCode}**. Select your store:`, components: [storeRow] });
            return;
          }

          if (interaction.customId === 'foodie_missing_modal') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const stateKey = `${interaction.user.id}:${interaction.guildId}`;
            const pending = pendingFoodieOrders.get(stateKey);
            if (!pending) {
              return await interaction.editReply({ content: '❌ Session expired. Please run `/formatorderfoodie` again.' });
            }
            pendingFoodieOrders.delete(stateKey);
            const formText = interaction.fields.getTextInputValue('foodie_form');
            const mergedCustomers = mergeFoodieFormResponse(formText, pending.customers);
            const formatted = formatFoodieCustomers(mergedCustomers, pending.config);
            const buf = Buffer.from(formatted, 'utf8');
            const file = new AttachmentBuilder(buf, { name: 'formatted_orders.txt' });
            return await interaction.editReply({
              content: `✅ Formatted **${mergedCustomers.length}** order(s).`,
              files: [file],
            });
          }

          if (interaction.customId === 'config_modal') {
            const newConfig = {
              welcomeMessage: interaction.fields.getTextInputValue('welcomeMessage'),
              entreePrompt: interaction.fields.getTextInputValue('entreePrompt'),
              proteinPrompt: interaction.fields.getTextInputValue('proteinPrompt'),
              checkoutMessage: interaction.fields.getTextInputValue('checkoutMessage'),
              successMessage: interaction.fields.getTextInputValue('successMessage'),
            };

            const success = await updateGuildConfig(interaction.guildId!, newConfig);
            if (success) {
              await handleSetup(interaction, '✅ Bot messages updated!');
            } else {
              await interaction.reply({ content: '❌ Failed to update configuration. Check server logs.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'setpayment_modal') {
            const venmoHandle = interaction.fields.getTextInputValue('venmo');
            const zelle = interaction.fields.getTextInputValue('zelle');
            const cashappTag = interaction.fields.getTextInputValue('cashapp');
            const crypto = interaction.fields.getTextInputValue('crypto');
            const config = await getGuildConfig(interaction.guildId!) || {};
            const newConfig: any = { ...config };
            if (venmoHandle) newConfig.venmoHandle = venmoHandle;
            if (cashappTag) newConfig.cashappTag = cashappTag;
            if (zelle) newConfig.zelleEmail = zelle;
            if (crypto) newConfig.cryptoAddress = crypto;
            const success = await updateGuildConfig(interaction.guildId!, newConfig);
            if (success) {
              await interaction.reply({ content: '✅ Payment methods updated successfully!', flags: MessageFlags.Ephemeral });
            } else {
              await interaction.reply({ content: '❌ Failed to update payment methods.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'branding_modal') {
            const color = interaction.fields.getTextInputValue('color');
            const displayName = interaction.fields.getTextInputValue('displayName');
            const footer = interaction.fields.getTextInputValue('footer');
            const avatar = interaction.fields.getTextInputValue('avatar');
            const status = interaction.fields.getTextInputValue('status');

            const config = await getGuildConfig(interaction.guildId!) || {};
            const newConfig = { ...config, embedColor: color, botDisplayName: displayName, footerText: footer, avatarUrl: avatar, statusMessage: status };
            const success = await updateGuildConfig(interaction.guildId!, newConfig);
            
            let extraMsg = '';
            if (avatar) {
              try {
                await client.user?.setAvatar(avatar);
                extraMsg += '\n✅ Profile picture updated.';
              } catch (e) {
                extraMsg += '\n❌ Failed to update profile picture (invalid URL or rate limited).';
              }
            }
            if (status) {
              client.user?.setActivity(status);
              extraMsg += '\n✅ Status message updated.';
            }
            
            if (success) {
              await handleSetup(interaction, `✅ Branding updated!${extraMsg}`);
            } else {
              await interaction.reply({ content: '❌ Failed to update branding.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'format_modal') {
            const headerFmt = interaction.fields.getTextInputValue('headerFormat');
            const itemFmt = interaction.fields.getTextInputValue('itemFormat');
            const config = await getGuildConfig(interaction.guildId!) || {};
            const success = await updateGuildConfig(interaction.guildId!, { ...config, orderHeaderFormat: headerFmt, orderItemFormat: itemFmt });
            if (success) {
              await interaction.reply({ content: '✅ Order format updated! It will apply to all future confirmed orders.', flags: MessageFlags.Ephemeral });
            } else {
              await interaction.reply({ content: '❌ Failed to save format. Check server logs.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'setup_webhook_modal') {
            const webhookUrl = interaction.fields.getTextInputValue('webhookUrl').trim();
            const statusChannelId = interaction.fields.getTextInputValue('statusChannelId').trim();
            if (webhookUrl && !isValidDiscordWebhookUrl(webhookUrl)) {
              return await interaction.reply({ content: '❌ Invalid webhook URL. Must be `https://discord.com/api/webhooks/...`', flags: MessageFlags.Ephemeral });
            }
            const cfg = await getGuildConfig(interaction.guildId!) || {};
            const updates: any = { ...cfg };
            if (webhookUrl) updates.webhookUrl = webhookUrl;
            if (statusChannelId) updates.statusChannelId = statusChannelId;
            const success = await updateGuildConfig(interaction.guildId!, updates);
            if (success) {
              await handleSetup(interaction, '✅ Webhook and channel settings saved!');
            } else {
              await interaction.reply({ content: '❌ Failed to save.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'setup_payments_modal') {
            const cashapp = interaction.fields.getTextInputValue('cashapp').trim();
            const venmo = interaction.fields.getTextInputValue('venmo').trim();
            const zelle = interaction.fields.getTextInputValue('zelle').trim();
            const paypal = interaction.fields.getTextInputValue('paypal').trim();
            const cfg = await getGuildConfig(interaction.guildId!) || {};
            const updates: any = { ...cfg };
            if (cashapp) updates.cashappTag = cashapp;
            if (venmo) updates.venmoHandle = venmo;
            if (zelle) updates.zelleEmail = zelle;
            if (paypal) updates.paypalEmail = paypal;
            const success = await updateGuildConfig(interaction.guildId!, updates);
            if (success) {
              await handleSetup(interaction, '✅ Payment methods saved!');
            } else {
              await interaction.reply({ content: '❌ Failed to save.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'setup_pricing_modal') {
            const basePriceStr = interaction.fields.getTextInputValue('basePrice').trim();
            const bulkPriceStr = interaction.fields.getTextInputValue('bulkPrice').trim();
            const bulkThreshStr = interaction.fields.getTextInputValue('bulkThreshold').trim();
            const basePrice = parseFloat(basePriceStr);
            if (isNaN(basePrice) || basePrice <= 0) {
              return await interaction.reply({ content: '❌ Invalid price. Enter a number like `5.00`.', flags: MessageFlags.Ephemeral });
            }
            const cfg = await getGuildConfig(interaction.guildId!) || {};
            const updates: any = { ...cfg, basePrice };
            if (bulkPriceStr) { const v = parseFloat(bulkPriceStr); if (!isNaN(v)) updates.bulkPrice = v; }
            if (bulkThreshStr) { const v = parseInt(bulkThreshStr); if (!isNaN(v)) updates.bulkThreshold = v; }
            const success = await updateGuildConfig(interaction.guildId!, updates);
            if (success) {
              await handleSetup(interaction, `✅ Pricing saved! Standard: **$${basePrice.toFixed(2)}**/entree.`);
            } else {
              await interaction.reply({ content: '❌ Failed to save.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'setup_staff_modal') {
            const staffRoleId = interaction.fields.getTextInputValue('staffRoleId').trim();
            const cfg = await getGuildConfig(interaction.guildId!) || {};
            const updates: any = { ...cfg };
            if (staffRoleId) updates.staffRoleId = staffRoleId;
            const success = await updateGuildConfig(interaction.guildId!, updates);
            if (success) {
              await handleSetup(interaction, '✅ Staff role saved!');
            } else {
              await interaction.reply({ content: '❌ Failed to save.', flags: MessageFlags.Ephemeral });
            }
          }

          if (interaction.customId === 'order_info_modal') {
            const email = interaction.fields.getTextInputValue('email');
            if (!email.toLowerCase().endsWith('@gmail.com')) {
              return await interaction.reply({ content: '❌ Error: Email must be a Gmail address.', flags: MessageFlags.Ephemeral });
            }

            const rawPhone = interaction.fields.getTextInputValue('phone');
            if (!/^[+]?[\d\s()\-]{7,20}$/.test(rawPhone)) {
              return await interaction.reply({ content: '❌ Error: Please enter a valid phone number.', flags: MessageFlags.Ephemeral });
            }

            const zipCode = interaction.fields.getTextInputValue('zipcode').replace(/\D/g, '').slice(0, 5);
            if (!/^\d{5}$/.test(zipCode)) {
              return await interaction.reply({ content: '❌ Please enter a valid 5-digit US zip code.', flags: MessageFlags.Ephemeral });
            }

            const rawEntrees = interaction.fields.getTextInputValue('entrees').trim();
            const parsedEntrees = parseInt(rawEntrees, 10);
            if (isNaN(parsedEntrees) || parsedEntrees < 1 || parsedEntrees > 8) {
              return await interaction.reply({ content: '❌ Please enter a number of entrees between 1 and 8.', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferUpdate();

            // Convert zip to coordinates
            let lat: number, lng: number, cityName: string, stateAbbr: string;
            try {
              const geoRes = await fetch(`https://api.zippopotam.us/us/${zipCode}`);
              if (!geoRes.ok) throw new Error('Zip not found');
              const geoData: any = await geoRes.json();
              if (!geoData.places || geoData.places.length === 0) throw new Error('No places returned for zip');
              lat = parseFloat(geoData.places[0].latitude);
              lng = parseFloat(geoData.places[0].longitude);
              stateAbbr = geoData.places[0]['state abbreviation'];
              cityName = `${geoData.places[0]['place name']}, ${stateAbbr}`;
            } catch (e) {
              return await interaction.editReply({ content: '❌ Could not find that zip code. Please enter a valid US zip code.' });
            }

            // Haversine distance in miles
            const distMiles = (lat1: number, lon1: number, lat2: number, lon2: number) => {
              const R = 3958.8;
              const dLat = (lat2 - lat1) * Math.PI / 180;
              const dLon = (lon2 - lon1) * Math.PI / 180;
              const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
              return R * 2 * Math.asin(Math.sqrt(a));
            };

            // Helper to normalize an element into a store object
            const toStore = (elLat: number, elLon: number, tags: any) => ({
              _lat: elLat,
              _lon: elLon,
              _miles: distMiles(lat, lng, elLat, elLon),
              name: tags.name || 'Chipotle',
              houseNumber: tags['addr:housenumber'] || '',
              street: tags['addr:street'] || '',
              city: tags['addr:city'] || '',
              stateTag: tags['addr:state'] || '',
              postcode: tags['addr:postcode'] || ''
            });

            // Fetch nearby Chipotle locations — run MapTiler and Overpass in parallel, use first with results
            const fetchMapTiler = async (): Promise<any[]> => {
              const res = await fetch(
                `https://api.maptiler.com/geocoding/Chipotle%20Mexican%20Grill.json?proximity=${lng},${lat}&limit=10&types=poi&key=MDqZ9Tw4PuuEnadIszzz`
              );
              if (!res.ok) throw new Error('MapTiler error');
              const data: any = await res.json();
              const results = (data.features || []).map((f: any) => {
                const [fLon, fLat] = f.geometry?.coordinates || [0, 0];
                const tags = f.properties?.feature_tags || {};
                return {
                  _lat: fLat, _lon: fLon,
                  _miles: distMiles(lat, lng, fLat, fLon),
                  name: f.text || 'Chipotle',
                  houseNumber: tags['addr:housenumber'] || '',
                  street: tags['addr:street'] || '',
                  city: tags['addr:city'] || '',
                  stateTag: tags['addr:state'] || '',
                  postcode: tags['addr:postcode'] || ''
                };
              }).filter((s: any) => s._miles <= 25).sort((a: any, b: any) => a._miles - b._miles).slice(0, 5);
              if (results.length === 0) throw new Error('No MapTiler results');
              return results;
            };

            const fetchOverpass = async (): Promise<any[]> => {
              const radiusMeters = 40234;
              const query = `[out:json][timeout:15];(node["name"~"Chipotle",i](around:${radiusMeters},${lat},${lng});way["name"~"Chipotle",i](around:${radiusMeters},${lat},${lng}););out center;`;
              const res = await fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `data=${encodeURIComponent(query)}`
              });
              if (!res.ok) throw new Error('Overpass error');
              const data: any = await res.json();
              const results = (data.elements || [])
                .filter((e: any) => (e.lat ?? e.center?.lat) != null && (e.lon ?? e.center?.lon) != null)
                .map((e: any) => toStore(e.lat ?? e.center?.lat, e.lon ?? e.center?.lon, e.tags || {}))
                .sort((a: any, b: any) => a._miles - b._miles)
                .slice(0, 5);
              if (results.length === 0) throw new Error('No Overpass results');
              return results;
            };

            let stores: any[] = [];
            try {
              stores = await Promise.any([fetchMapTiler(), fetchOverpass()]);
            } catch (e) {
              console.error('All location sources failed:', e);
              return await interaction.editReply({ content: '❌ Could not retrieve Chipotle locations. Please try again.' });
            }

            if (stores.length === 0) {
              return await interaction.editReply({ content: `❌ No Chipotle locations found within 25 miles of **${zipCode}**. Try a nearby zip code.` });
            }

            // Save partial order state (location filled in after store selection)
            const timezone = resolveTimezoneFromState(stateAbbr!);
            const maxEntrees = parsedEntrees;
            orderState.set(`${interaction.user.id}:${interaction.guildId}`, {
              guildId: interaction.guildId,
              maxEntrees,
              info: {
                name: sanitizeInput(interaction.fields.getTextInputValue('name'), 100),
                location: '',
                time: '',
                phone: sanitizeInput(rawPhone, 20),
                email: sanitizeInput(email, 100),
                lat,
                lng,
                timezone
              },
              orders: [],
              editingIndex: null,
              lastUpdated: Date.now()
            });

            // Build store select menu — use index-prefixed values to guarantee uniqueness
            const storeSelect = new StringSelectMenuBuilder()
              .setCustomId('store_select')
              .setPlaceholder('📍 Select your Chipotle location')
              .addOptions(
                stores.map((store: any, idx: number) => {
                  const streetAddr = `${store.houseNumber} ${store.street}`.trim();
                  const fullAddress = `${streetAddr}, ${store.city}, ${store.stateTag} ${store.postcode}`.trim().replace(/^,\s*/, '');
                  const miles = store._miles.toFixed(1);
                  // Prefix with index to prevent duplicate value errors when two stores share the same address string
                  const value = `${idx}:${(fullAddress || `${store._lat},${store._lon}`)}`.slice(0, 100);
                  return {
                    label: (streetAddr || store.city || 'Chipotle').slice(0, 100),
                    description: `${store.city}, ${store.stateTag} ${store.postcode} — ${miles} mi away`.slice(0, 100),
                    value
                  };
                })
              );
            const storeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(storeSelect);
            await interaction.editReply({
              content: `📍 Found **${stores.length}** Chipotle location(s) near **${cityName} ${zipCode}**. Select your store:`,
              components: [storeRow]
            });
          }

          if (interaction.customId === 'item_name_modal') {
            const state = orderState.get(`${interaction.user.id}:${interaction.guildId}`);
            if (!state) return await interaction.reply({ content: '❌ Session expired. Use `/order` to start over.', flags: MessageFlags.Ephemeral });
            const entreeNameVal = interaction.fields.getTextInputValue('item_name').trim();
            if (state.orders.length > 0) {
              state.orders[state.orders.length - 1].entreeName = entreeNameVal || '';
            }
            await interaction.deferUpdate();
            await showReview(interaction, state);
          }

          if (interaction.customId === 'repeat_order_modal') {
            const state = orderState.get(`${interaction.user.id}:${interaction.guildId}`);
            if (!state) return await interaction.reply({ content: '❌ Session expired. Use `/order` to start over.', flags: MessageFlags.Ephemeral });
            const rawCount = interaction.fields.getTextInputValue('repeat_count').trim();
            const count = parseInt(rawCount, 10);
            if (isNaN(count) || count < 2 || count > 9) {
              return await interaction.reply({ content: '❌ Please enter a number between 2 and 9.', flags: MessageFlags.Ephemeral });
            }
            // Duplicate current orders: replace state.orders with count copies
            const original = [...state.orders];
            const repeated: any[] = [];
            for (let i = 0; i < count; i++) {
              for (const item of original) {
                if (repeated.length >= 9) break;
                repeated.push({ ...item });
              }
              if (repeated.length >= 9) break;
            }
            state.orders = repeated;
            state.maxEntrees = repeated.length;
            await interaction.deferUpdate();
            await showReview(interaction, state);
          }
        }

        if (interaction.isStringSelectMenu() || interaction.isButton()) {
          if (interaction.customId.startsWith('admin_')) {
            const config = await getGuildConfig(interaction.guildId!) || {};
            const isStaff = config.staffRoleId && interaction.member?.roles && (interaction.member.roles as any).cache.has(config.staffRoleId);
            const isAdmin = interaction.memberPermissions?.has('Administrator');
            if (!isAdmin && !isStaff) {
              return await interaction.reply({ content: '❌ You do not have permission.', flags: MessageFlags.Ephemeral });
            }
            if (interaction.isStringSelectMenu()) {
              if (interaction.customId === 'admin_filter_status') {
                await interaction.deferUpdate();
                await showAdminOrders(interaction, interaction.values[0]);
              } else if (interaction.customId === 'admin_order_select') {
                await interaction.deferUpdate();
                const orderId = interaction.values[0];
                const orderDoc = await db.collection('orders').doc(orderId).get();
                if (!orderDoc.exists || orderDoc.data()?.guildId !== interaction.guildId) {
                  return await interaction.editReply({ content: '❌ Order not found in this server.', embeds: [], components: [] });
                }
                const order = orderDoc.data();

                const parsedOrders = safeParseOrders(order?.orderData);
                const parsedUserInfo = safeParseUserInfo(order?.userInfo);

                const formattedOrders = formatOrderItems(parsedOrders);

                const config = await getGuildConfig(interaction.guildId!) || {};
                const embed = createEmbed(config)
                  .setTitle(`Order Details: ${orderId.slice(0, 8)}`)
                  .addFields(
                    { name: 'Customer', value: parsedUserInfo.name || 'N/A', inline: true },
                    { name: 'Phone', value: parsedUserInfo.phone || 'N/A', inline: true },
                    { name: 'Status', value: order?.status || 'Unknown', inline: true },
                    { name: 'Items', value: formattedOrders || 'No items' }
                  );

                const row = makeSelect(`admin_status_update_${orderId}`, 'Update status', ORDER_STATUS_OPTIONS);
                const backBtn = new ButtonBuilder()
                  .setCustomId('admin_back_to_orders')
                  .setLabel('Back to Orders')
                  .setStyle(ButtonStyle.Secondary);
                const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
                await interaction.editReply({ embeds: [embed], components: [row, row2] });
              } else if (interaction.customId.startsWith('admin_status_update_')) {
                await interaction.deferUpdate();
                const orderId = interaction.customId.replace('admin_status_update_', '');
                const newStatus = interaction.values[0];

                const orderRef = db.collection('orders').doc(orderId);
                const orderDoc = await orderRef.get();
                if (!orderDoc.exists || orderDoc.data()?.guildId !== interaction.guildId) {
                  return await interaction.editReply({ content: '❌ Order not found in this server.', embeds: [], components: [] });
                }
                const orderData = orderDoc.data();

                const backBtn = new ButtonBuilder()
                  .setCustomId('admin_back_to_orders')
                  .setLabel('Back to Orders')
                  .setStyle(ButtonStyle.Secondary);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

                if (newStatus === 'paid' && orderData?.status !== 'paid' && orderData?.status !== 'paid_fulfilled') {
                  await fulfillOrder(orderId);
                  await interaction.editReply({ content: `✅ Order ${orderId} payment manually confirmed and sent to kitchen.`, embeds: [], components: [row] });
                } else {
                  await orderRef.update({ status: newStatus });
                  await interaction.editReply({ content: `✅ Order ${orderId} updated to ${newStatus}.`, embeds: [], components: [row] });
                }

                if (orderData?.userId) {
                  try {
                    let statusMessage = '';
                    if (newStatus === 'paid_fulfilled') {
                      statusMessage = '🎉 Good news! Your order has been fulfilled and is ready for pickup!';
                    } else if (newStatus !== 'paid') {
                      statusMessage = `ℹ️ Your order status has been updated to: ${newStatus}`;
                    }
                    if (statusMessage) {
                      const target = await client.users.fetch(orderData.userId);
                      await target.send(statusMessage);
                    }
                  } catch (err: any) {
                    console.error(`Failed to send DM to user ${orderData.userId}:`, err?.message ?? err);
                  }
                }
              }
            } else if (interaction.isButton()) {
              if (interaction.customId === 'admin_back_to_orders') {
                await interaction.deferUpdate();
                await showAdminOrders(interaction, 'pending');
              } else if (interaction.customId === 'admin_pending_confirm_all') {
                await interaction.deferUpdate();
                const pendingStatuses = ['pending', 'pending_cashapp', 'pending_venmo', 'pending_zelle', 'pending_crypto', 'pending_paypal'];
                let confirmedCount = 0;
                let failedCount = 0;
                const statusSnaps = await Promise.all(
                  pendingStatuses.map(status =>
                    db.collection('orders').where('status', '==', status).where('guildId', '==', interaction.guildId).get()
                  )
                );
                const allDocs = statusSnaps.flatMap(snap => snap.docs);
                const results = await Promise.all(
                  allDocs.map(orderDoc =>
                    fulfillOrder(orderDoc.id).then(success => ({ success })).catch(e => {
                      console.error(`Failed to fulfill order ${orderDoc.id}:`, e);
                      return { success: false };
                    })
                  )
                );
                for (const r of results) {
                  if (r.success) confirmedCount++;
                  else failedCount++;
                }
                const config = await getGuildConfig(interaction.guildId!) || {};
                let description = confirmedCount > 0
                  ? `Successfully confirmed and sent **${confirmedCount}** order(s) to the kitchen.`
                  : 'No pending orders to confirm.';
                if (failedCount > 0) description += `\n⚠️ **${failedCount}** order(s) failed to confirm — check the console logs.`;
                const embed = createEmbed(config)
                  .setTitle('✅ All Pending Orders Confirmed')
                  .setDescription(description);
                await interaction.editReply({ embeds: [embed], components: [] });
              } else if (interaction.customId.startsWith('admin_confirm_all_')) {
                await interaction.deferUpdate();
                const { status: statusToConfirm, name: paymentName } = CONFIRM_ALL_STATUS_MAP[interaction.customId] || { status: 'pending', name: '' };

                const ordersQuery = db.collection('orders').where('status', '==', statusToConfirm).where('guildId', '==', interaction.guildId);
                const ordersSnapshot = await ordersQuery.get();

                const fulfillResults = await Promise.all(
                  ordersSnapshot.docs.map(orderDoc => fulfillOrder(orderDoc.id))
                );
                let confirmedCount = fulfillResults.filter(Boolean).length;

                const config = await getGuildConfig(interaction.guildId!) || {};
                const embed = createEmbed(config)
                  .setTitle('✅ Mass Confirmation Complete')
                  .setDescription(`Successfully confirmed and sent ${confirmedCount} ${paymentName}order(s) to the kitchen.`);
                  
                const backBtn = new ButtonBuilder()
                  .setCustomId('admin_back_to_orders')
                  .setLabel('Back to Orders')
                  .setStyle(ButtonStyle.Secondary);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
                
                await interaction.editReply({ embeds: [embed], components: [row] });
              } else if (interaction.customId === 'admin_clear_batch') {
                await interaction.deferUpdate();
                const ordersQuery = db.collection('orders').where('batchStatus', '==', 'pending').where('guildId', '==', interaction.guildId);
                const ordersSnapshot = await ordersQuery.get();

                let clearedCount = 0;
                for (const orderDoc of ordersSnapshot.docs) {
                  await db.collection('orders').doc(orderDoc.id).update({ batchStatus: 'cleared' });
                  clearedCount++;
                }

                const config = await getGuildConfig(interaction.guildId!) || {};
                const embed = createEmbed(config)
                  .setTitle('✅ Batch Cleared')
                  .setDescription(`Successfully cleared ${clearedCount} order(s) from the batch.`);
                  
                await interaction.editReply({ embeds: [embed], components: [] });
              }
            }
            return;
          }

          // Handle setup dashboard buttons
          if (interaction.isButton() && interaction.customId.startsWith('setup_')) {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ You must be an Administrator to use setup.', flags: MessageFlags.Ephemeral });
            }
            const cfg = await getGuildConfig(interaction.guildId!) || {};

            if (interaction.customId === 'setup_webhook') {
              const modal = new ModalBuilder().setCustomId('setup_webhook_modal').setTitle('🔗 Webhook & Status Channel');
              const webhookInput = new TextInputBuilder().setCustomId('webhookUrl').setLabel('Order Notifications Webhook URL').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('https://discord.com/api/webhooks/...');
              if (cfg.webhookUrl) webhookInput.setValue(cfg.webhookUrl);
              const channelInput = new TextInputBuilder().setCustomId('statusChannelId').setLabel('Status Channel ID (renames on open/close)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('Right-click channel → Copy ID');
              if (cfg.statusChannelId) channelInput.setValue(cfg.statusChannelId);
              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(webhookInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(channelInput),
              );
              return await interaction.showModal(modal);
            }

            if (interaction.customId === 'setup_payments') {
              const modal = new ModalBuilder().setCustomId('setup_payments_modal').setTitle('💸 Payment Methods');
              const cashInput = new TextInputBuilder().setCustomId('cashapp').setLabel('Cash App $tag').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('$YourTag');
              if (cfg.cashappTag) cashInput.setValue(cfg.cashappTag);
              const venmoInput = new TextInputBuilder().setCustomId('venmo').setLabel('Venmo Username').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('@YourUsername');
              if (cfg.venmoHandle) venmoInput.setValue(cfg.venmoHandle);
              const zelleInput = new TextInputBuilder().setCustomId('zelle').setLabel('Zelle Email or Phone').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('email@example.com or +1...');
              if (cfg.zelleEmail) zelleInput.setValue(cfg.zelleEmail);
              const paypalInput = new TextInputBuilder().setCustomId('paypal').setLabel('PayPal Email').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('you@email.com');
              if (cfg.paypalEmail) paypalInput.setValue(cfg.paypalEmail);
              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(cashInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(venmoInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(zelleInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(paypalInput),
              );
              return await interaction.showModal(modal);
            }

            if (interaction.customId === 'setup_pricing') {
              const modal = new ModalBuilder().setCustomId('setup_pricing_modal').setTitle('💰 Pricing');
              const baseInput = new TextInputBuilder().setCustomId('basePrice').setLabel('Standard price per entree ($)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('5.00');
              if (cfg.basePrice) baseInput.setValue(String(cfg.basePrice));
              const bulkPriceInput = new TextInputBuilder().setCustomId('bulkPrice').setLabel('Bulk discount price (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('4.50');
              if (cfg.bulkPrice) bulkPriceInput.setValue(String(cfg.bulkPrice));
              const bulkThreshInput = new TextInputBuilder().setCustomId('bulkThreshold').setLabel('Bulk threshold (# of entrees)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('3');
              if (cfg.bulkThreshold) bulkThreshInput.setValue(String(cfg.bulkThreshold));
              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(baseInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(bulkPriceInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(bulkThreshInput),
              );
              return await interaction.showModal(modal);
            }

            if (interaction.customId === 'setup_staff') {
              const modal = new ModalBuilder().setCustomId('setup_staff_modal').setTitle('👥 Staff Role');
              const roleInput = new TextInputBuilder().setCustomId('staffRoleId').setLabel('Staff Role ID').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('Enable Developer Mode → right-click role → Copy ID');
              if (cfg.staffRoleId) roleInput.setValue(cfg.staffRoleId);
              modal.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(roleInput));
              return await interaction.showModal(modal);
            }

            if (interaction.customId === 'setup_messages') {
              const modal = new ModalBuilder().setCustomId('config_modal').setTitle('💬 Bot Messages');
              const welcomeInput = new TextInputBuilder().setCustomId('welcomeMessage').setLabel('Welcome Message').setStyle(TextInputStyle.Paragraph).setValue(cfg.welcomeMessage || 'Great! Now choose your entree:').setRequired(false);
              const entreeInput = new TextInputBuilder().setCustomId('entreePrompt').setLabel('Entree Selection Prompt').setStyle(TextInputStyle.Short).setValue(cfg.entreePrompt || 'Choose your entree:').setRequired(false);
              const proteinInput = new TextInputBuilder().setCustomId('proteinPrompt').setLabel('Protein Selection Prompt').setStyle(TextInputStyle.Short).setValue(cfg.proteinPrompt || 'Now choose your protein:').setRequired(false);
              const checkoutInput = new TextInputBuilder().setCustomId('checkoutMessage').setLabel('Checkout Instructions').setStyle(TextInputStyle.Paragraph).setValue(cfg.checkoutMessage || 'Please pay using the link below.').setRequired(false);
              const successInput = new TextInputBuilder().setCustomId('successMessage').setLabel('Success Confirmation').setStyle(TextInputStyle.Paragraph).setValue(cfg.successMessage || '✅ Payment confirmed! Your order has been sent to the kitchen.').setRequired(false);
              modal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(welcomeInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(entreeInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(proteinInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(checkoutInput),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(successInput),
              );
              return await interaction.showModal(modal);
            }

            if (interaction.customId === 'setup_branding') {
              return await handleBranding(interaction);
            }
          }

          // Handle "Place My Order" button shown in pre-order schedule embed
          if (interaction.isButton() && interaction.customId === 'foodie_fill_missing') {
            const stateKey = `${interaction.user.id}:${interaction.guildId}`;
            const pending = pendingFoodieOrders.get(stateKey);
            if (!pending) {
              return await interaction.reply({ content: '❌ Session expired. Please run `/formatorderfoodie` again.', flags: MessageFlags.Ephemeral });
            }
            const formText = buildFoodieForm(pending.customers);
            const modal = new ModalBuilder()
              .setCustomId('foodie_missing_modal')
              .setTitle('Fill In Missing Order Info');
            const textInput = new TextInputBuilder()
              .setCustomId('foodie_form')
              .setLabel('Fill in answers after each ? on the same line')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(formText)
              .setRequired(true);
            modal.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(textInput));
            return await interaction.showModal(modal);
          }

          if (interaction.isButton() && interaction.customId === 'start_order_modal') {
            const config = await getGuildConfig(interaction.guildId!) || {};
            if (config.storeOpen === false) {
              return await interaction.update({ content: '❌ **The store is currently closed.** We are not accepting new orders at this time.', components: [], embeds: [] });
            }
            try {
              const blacklistDoc = await db.collection('guilds').doc(interaction.guildId!).collection('blacklist').doc(interaction.user.id).get();
              if (blacklistDoc.exists) {
                return await interaction.update({ content: '❌ You have been blocked from placing orders.', components: [], embeds: [] });
              }
            } catch (e) { /* ignore */ }
            return await showOrderModal(interaction);
          }

          const state = orderState.get(`${interaction.user.id}:${interaction.guildId}`);
          if (!state) {
            return await interaction.reply({ content: '❌ Session expired. Please use `/order` again.', flags: MessageFlags.Ephemeral });
          }
          state.lastUpdated = Date.now();

          if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'store_select') {
              // Strip the index prefix (e.g. "0:1260 North Fry Road..." → "1260 North Fry Road...")
              state.info.location = interaction.values[0].replace(/^\d+:/, '');
              state.lastUpdated = Date.now();
              await showPickupTimeSelect(interaction, state);
            } else if (interaction.customId === 'pickup_time_select' || interaction.customId.startsWith('pickup_time_select_')) {
              await interaction.deferUpdate();
              state.info.time = interaction.values[0];
              state.lastUpdated = Date.now();
              if (state.pendingReview) {
                state.pendingReview = false;
                await showReview(interaction, state);
              } else {
                await showEntreeSelect(interaction, state);
              }
            } else if (interaction.customId === 'entree_select') {
              state.currentOrder = { type: interaction.values[0], proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
              await showProteinSelect(interaction, state);
            } else if (interaction.customId === 'protein_select') {
              state.currentOrder.proteins = [interaction.values[0]];
              await showProteinPortion(interaction, state);
            } else if (interaction.customId === 'rice_select') {
              state.currentOrder.rice.type = interaction.values[0];
              if (state.currentOrder.rice.type === 'None') {
                await showBeansSelect(interaction, state);
              } else {
                await showRicePortion(interaction, state);
              }
            } else if (interaction.customId === 'beans_select') {
              state.currentOrder.beans.type = interaction.values[0];
              if (state.currentOrder.beans.type === 'None') {
                await showToppingsSelect(interaction, state);
              } else {
                await showBeansPortion(interaction, state);
              }
            } else if (interaction.customId === 'toppings_select') {
              state.currentOrder.selectedToppings = interaction.values;
              if (state.currentOrder.selectedToppings.length > 0) {
                state.toppingIndex = 0;
                state.currentOrder.toppings = [];
                await showToppingPortion(interaction, state, 0);
              } else {
                await showPremiumSelect(interaction, state);
              }
            } else if (interaction.customId === 'premium_select') {
              state.currentOrder.premiums = interaction.values.filter((v: string) => v !== 'None');
              const isEditing = state.editingIndex !== null && state.editingIndex !== undefined;
              if (isEditing) {
                state.orders.splice(state.editingIndex, 0, state.currentOrder);
                state.editingIndex = null;
              } else {
                state.orders.push(state.currentOrder);
              }

              // If ordering multiple entrees and not editing, ask who this entree is for
              if (!isEditing && (state.maxEntrees || 1) > 1) {
                const itemIndex = state.orders.length;
                const nameModal = new ModalBuilder()
                  .setCustomId('item_name_modal')
                  .setTitle(`Entree ${itemIndex} — Who is this for?`);
                const nameInput = new TextInputBuilder()
                  .setCustomId('item_name')
                  .setLabel(`Name for entree ${itemIndex} (optional)`)
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('e.g. John')
                  .setRequired(false);
                nameModal.addComponents(
                  new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(nameInput)
                );
                return await interaction.showModal(nameModal);
              }

              const type = state.currentOrder.type;
              const emoji = type.includes('Bowl') ? '🥗' : (type === 'Tacos' ? '🌮' : '🌯');
              const actionText = isEditing ? 'Updating your' : 'Wrapping your';

              await interaction.update({ content: `${emoji} ${actionText} ${type.toLowerCase()}...`, components: [], embeds: [] });
              await interaction.editReply({ content: `✅ Item ${isEditing ? 'updated' : 'added to cart'}!`, components: [], embeds: [] });

              await showReview(interaction, state);
            } else if (interaction.customId === 'edit_item_select') {
              const index = parseInt(interaction.values[0]);
              state.editingIndex = index;
              const itemToEdit = state.orders.splice(index, 1)[0];
              state.currentOrder = itemToEdit;
              await showEntreeSelect(interaction, state);
            } else if (interaction.customId === 'remove_item_select') {
              const index = parseInt(interaction.values[0]);
              state.orders.splice(index, 1);
              if (state.orders.length === 0) {
                state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
                await interaction.update({ content: '🛒 Your cart is now empty. Let\'s add something!', components: [], embeds: [] });
                await showEntreeSelect(interaction, state);
              } else {
                await showReview(interaction, state);
              }
            }
          } else if (interaction.isButton()) {
            if (interaction.customId === 'protein_double') {
              state.currentOrder.isDouble = true;
              await showRiceSelect(interaction, state);
            } else if (interaction.customId === 'protein_skip') {
              state.currentOrder.isDouble = false;
              await showRiceSelect(interaction, state);
            } else if (interaction.customId.startsWith('rice_portion_')) {
              state.currentOrder.rice.portion = interaction.customId.split('_')[2];
              await showBeansSelect(interaction, state);
            } else if (interaction.customId.startsWith('beans_portion_')) {
              state.currentOrder.beans.portion = interaction.customId.split('_')[2];
              await showToppingsSelect(interaction, state);
            } else if (interaction.customId.startsWith('topping_portion_')) {
              const index = parseInt(interaction.customId.split('_')[2]);
              const portion = interaction.customId.split('_')[3];
              const topping = state.currentOrder.selectedToppings[index];
              state.currentOrder.toppings.push({ type: topping, portion });

              if (index + 1 < state.currentOrder.selectedToppings.length) {
                state.toppingIndex = index + 1;
                await showToppingPortion(interaction, state, index + 1);
              } else {
                await showPremiumSelect(interaction, state);
              }
            } else if (interaction.customId === 'repeat_order_start') {
              const maxCopies = Math.floor(9 / state.orders.length);
              const repeatModal = new ModalBuilder()
                .setCustomId('repeat_order_modal')
                .setTitle('Repeat Order');
              const countInput = new TextInputBuilder()
                .setCustomId('repeat_count')
                .setLabel(`How many total copies? (2–${Math.min(maxCopies, 9)})`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g. 3')
                .setRequired(true);
              repeatModal.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(countInput)
              );
              return await interaction.showModal(repeatModal);
            } else if (interaction.customId === 'add_more') {
              state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
              await showEntreeSelect(interaction, state);
            } else if (interaction.customId === 'edit_order_start') {
              await showEditSelect(interaction, state);
            } else if (interaction.customId === 'remove_item_start') {
              await showRemoveSelect(interaction, state);
            } else if (interaction.customId === 'checkout') {
              try {
                await interaction.deferUpdate();

                const config = await getGuildConfig(interaction.guildId!) || {};
                const basePrice = config.basePrice || 5.00;
                const bulkPrice = config.bulkPrice ?? null;
                const bulkThreshold = config.bulkThreshold ?? null;

                // Calculate actual price
                let totalPrice = 0;
                const numEntrees = state.orders.length;
                const currentBasePrice = (bulkPrice !== null && bulkThreshold !== null && numEntrees >= bulkThreshold) ? bulkPrice : basePrice;

                state.orders.forEach((order: any) => {
                  totalPrice += currentBasePrice;
                });
                totalPrice = Math.round(totalPrice * 100) / 100;

                const orderDataStr = JSON.stringify(state.orders);
                const userInfoStr = JSON.stringify(state.info);

                if (!db) {
                  console.error('❌ Firestore DB is not initialized.');
                  return await interaction.followUp({ content: '❌ Database error. Please contact the administrator.', flags: MessageFlags.Ephemeral });
                }

                // Stop any running Cash App or Zelle poller when returning to payment options
                const existingCashappPoller = cashappPollers.get(`cashapp:${interaction.user.id}:${interaction.guildId!}`);
                if (existingCashappPoller) {
                  clearInterval(existingCashappPoller.interval);
                  clearTimeout(existingCashappPoller.timeout);
                  cashappPollers.delete(`cashapp:${interaction.user.id}:${interaction.guildId!}`);
                }
                for (const provider of ['cashapp', 'venmo', 'zelle', 'paypal']) {
                  const ep = emailPaymentPollers.get(`email:${provider}:${interaction.user.id}:${interaction.guildId!}`);
                  if (ep) { clearInterval(ep.interval); clearTimeout(ep.timeout); emailPaymentPollers.delete(`email:${provider}:${interaction.user.id}:${interaction.guildId!}`); }
                }

                // Reuse existing pending order if there is one, to avoid orphaned orders
                let orderId = state.currentOrderId;
                if (orderId) {
                  try {
                    const existingDoc = await db.collection('orders').doc(orderId).get();
                    const existingStatus = existingDoc.data()?.status;
                    const isPaid = existingStatus === 'paid' || existingStatus === 'paid_fulfilled';
                    if (!existingDoc.exists || isPaid) {
                      orderId = null; // Force creating a new order
                    } else {
                      // Update existing order with current cart data
                      await db.collection('orders').doc(orderId).update({
                        orderData: orderDataStr,
                        userInfo: userInfoStr,
                        totalPrice: totalPrice,
                        status: 'pending',
                      });
                    }
                  } catch (e) {
                    console.error('Error checking existing order, creating new one:', e);
                    orderId = null;
                  }
                }

                if (!orderId) {
                  orderId = generateShortOrderId();
                  await db.collection('orders').doc(orderId).set({
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    orderData: orderDataStr,
                    userInfo: userInfoStr,
                    status: 'pending',
                    totalPrice: totalPrice,
                    createdAt: serverTimestamp()
                  });
                }

                state.currentOrderId = orderId;
                state.totalPrice = totalPrice;

                // Check user's wallet balance
                const walletDoc = await db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id).get();
                const walletBalance: number = walletDoc.exists ? (walletDoc.data()?.creditBalance || 0) : 0;

                const buttons: ButtonBuilder[] = [];

                // Wallet button — show if user has any balance
                if (walletBalance >= totalPrice) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_wallet').setLabel(`💳 Pay with Wallet ($${walletBalance.toFixed(2)})`).setStyle(ButtonStyle.Success));
                } else if (walletBalance >= 0.01) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_wallet_partial').setLabel(`💳 Use $${walletBalance.toFixed(2)} Wallet + Pay Rest`).setStyle(ButtonStyle.Secondary));
                }

                if (config.cashappTag) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_cashapp').setLabel('💸 Pay with Cash App').setStyle(ButtonStyle.Success));
                }
                if (config.venmoHandle) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_venmo').setLabel('🔵 Pay with Venmo').setStyle(ButtonStyle.Primary));
                }
                if (config.zelleEmail) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_zelle').setLabel('🟣 Pay with Zelle').setStyle(ButtonStyle.Secondary));
                }
                if (config.paypalEmail) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_paypal').setLabel('🅿️ Pay with PayPal').setStyle(ButtonStyle.Primary));
                }
                if (config.cryptoAddress) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_crypto').setLabel('🪙 Pay with Crypto').setStyle(ButtonStyle.Secondary));
                }

                const backBtn = new ButtonBuilder().setCustomId('back_to_review').setLabel('Back').setStyle(ButtonStyle.Danger);
                
                // Discord limits ActionRow to 5 buttons. If we have more, we need multiple rows.
                const rows: ActionRowBuilder<ButtonBuilder>[] = [];
                let currentRow = new ActionRowBuilder<ButtonBuilder>();
                
                for (const btn of buttons) {
                  if (currentRow.components.length >= 5) {
                    rows.push(currentRow);
                    currentRow = new ActionRowBuilder<ButtonBuilder>();
                  }
                  currentRow.addComponents(btn);
                }
                
                if (currentRow.components.length >= 5) {
                  rows.push(currentRow);
                  currentRow = new ActionRowBuilder<ButtonBuilder>();
                }
                currentRow.addComponents(backBtn);
                rows.push(currentRow);
                
                const walletLine = walletBalance >= 0.01
                  ? `\n💳 Wallet balance: **$${walletBalance.toFixed(2)}**${walletBalance >= totalPrice ? ' — enough to cover this order!' : ` — $${(totalPrice - walletBalance).toFixed(2)} short`}`
                  : '';
                await interaction.editReply({
                  content: `💰 Your order total is **$${totalPrice.toFixed(2)}**.\n\n💳 Please select your preferred payment method:${walletLine}`,
                  components: rows
                });
              } catch (err: any) {
                console.error('Checkout Error:', err);
                if (interaction.deferred || interaction.replied) {
                  await interaction.followUp({ content: `❌ Error creating order: ${err.message}`, flags: MessageFlags.Ephemeral });
                } else {
                  await interaction.reply({ content: `❌ Error creating order: ${err.message}`, flags: MessageFlags.Ephemeral });
                }
              }
            } else if (interaction.customId === 'confirm_manual') {
              await interaction.deferUpdate();
              const config = await getGuildConfig(interaction.guildId!) || {};
              const manualConfig = {
                ...config,
                orderHeaderFormat: `Customer: {name}\nPickup Location: {location}\nPickup Time: {time}\nPhone: {phone}\nEmail: {email}`,
              };
              const formatted = formatConfirmedOrderPayload('__manual__', state.info, state.orders, manualConfig);
              const buf  = Buffer.from(formatted, 'utf8');
              const file = new AttachmentBuilder(buf, { name: 'manual_order.txt' });
              orderState.delete(`${interaction.user.id}:${interaction.guildId}`);
              await interaction.editReply({ content: '✅ Manual order printed.', embeds: [], components: [], files: [file] });
            } else if (interaction.customId === 'pay_wallet') {
              try {
                await interaction.deferUpdate();
                if (!state.currentOrderId || !state.totalPrice) {
                  return await interaction.followUp({ content: '❌ No active order found.', flags: MessageFlags.Ephemeral });
                }
                const config = await getGuildConfig(interaction.guildId!) || {};
                const customerRef = db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id);

                // Atomically deduct — prevents double-spend
                let newBalance = 0;
                await db.runTransaction(async (txn) => {
                  const doc = await txn.get(customerRef);
                  const balance: number = doc.exists ? (doc.data()?.creditBalance || 0) : 0;
                  if (balance < state.totalPrice) throw new Error('Insufficient wallet balance');
                  newBalance = Math.round((balance - state.totalPrice) * 100) / 100;
                  txn.set(customerRef, { creditBalance: newBalance, lastCreditReason: `Order ${state.currentOrderId}`, lastCreditAdjustment: serverTimestamp() }, { merge: true });
                });

                await db.collection('orders').doc(state.currentOrderId).update({ status: 'paid', paymentMethod: 'wallet' });
                await fulfillOrder(state.currentOrderId, true);

                const successEmbed = createEmbed(config)
                  .setTitle('✅ Wallet Payment Confirmed!')
                  .setDescription(`**$${state.totalPrice.toFixed(2)}** deducted from your wallet.\nRemaining balance: **$${newBalance.toFixed(2)}**\n\nYour order is on its way to the kitchen!`);
                await interaction.editReply({ content: '', embeds: [successEmbed], components: [] });
              } catch (err: any) {
                console.error('Wallet pay error:', err);
                await interaction.followUp({ content: `❌ ${err.message || 'Error processing wallet payment.'}`, flags: MessageFlags.Ephemeral });
              }

            } else if (interaction.customId === 'pay_wallet_partial') {
              try {
                await interaction.deferUpdate();
                if (!state.currentOrderId || !state.totalPrice) {
                  return await interaction.followUp({ content: '❌ No active order found.', flags: MessageFlags.Ephemeral });
                }
                const config = await getGuildConfig(interaction.guildId!) || {};
                const customerRef = db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id);

                // Read current balance
                const walletDoc2 = await customerRef.get();
                const walletBal2: number = walletDoc2.exists ? (walletDoc2.data()?.creditBalance || 0) : 0;
                if (walletBal2 < 0.01) {
                  return await interaction.followUp({ content: '❌ No wallet balance available.', flags: MessageFlags.Ephemeral });
                }
                const remaining = Math.round((state.totalPrice - walletBal2) * 100) / 100;

                // Deduct full wallet balance atomically
                await db.runTransaction(async (txn) => {
                  const doc = await txn.get(customerRef);
                  const bal: number = doc.exists ? (doc.data()?.creditBalance || 0) : 0;
                  txn.set(customerRef, { creditBalance: 0, lastCreditReason: `Partial: Order ${state.currentOrderId}`, lastCreditAdjustment: serverTimestamp() }, { merge: true });
                });

                // Update order total to the remaining amount and save wallet credit applied
                state.totalPrice = remaining;
                await db.collection('orders').doc(state.currentOrderId).update({ totalPrice: remaining, walletCreditApplied: walletBal2 });

                // Now show payment buttons for the remaining amount
                const buttons2: ButtonBuilder[] = [];
                if (config.cashappTag) buttons2.push(new ButtonBuilder().setCustomId('pay_cashapp').setLabel('💸 Cash App').setStyle(ButtonStyle.Success));
                if (config.venmoHandle) buttons2.push(new ButtonBuilder().setCustomId('pay_venmo').setLabel('💸 Venmo').setStyle(ButtonStyle.Primary));
                if (config.zelleEmail) buttons2.push(new ButtonBuilder().setCustomId('pay_zelle').setLabel('💸 Zelle').setStyle(ButtonStyle.Primary));
                if (config.paypalEmail) buttons2.push(new ButtonBuilder().setCustomId('pay_paypal').setLabel('🅿️ PayPal').setStyle(ButtonStyle.Primary));
                if (config.cryptoAddress) buttons2.push(new ButtonBuilder().setCustomId('pay_crypto').setLabel('🪙 Crypto').setStyle(ButtonStyle.Secondary));

                if (!buttons2.length) {
                  return await interaction.followUp({ content: '❌ No payment methods configured for the remaining balance.', flags: MessageFlags.Ephemeral });
                }
                const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons2.slice(0, 5));
                await interaction.editReply({
                  content: `💳 **$${walletBal2.toFixed(2)}** wallet credit applied!\n\nPlease pay the remaining **$${remaining.toFixed(2)}** using one of the methods below:`,
                  components: [row2],
                  embeds: [],
                });
              } catch (err: any) {
                console.error('Partial wallet pay error:', err);
                await interaction.followUp({ content: `❌ ${err.message || 'Error processing partial wallet payment.'}`, flags: MessageFlags.Ephemeral });
              }

            } else if (['pay_cashapp', 'pay_venmo', 'pay_zelle', 'pay_crypto', 'pay_paypal'].includes(interaction.customId)) {
              try {
                await interaction.deferUpdate();
                const config = await getGuildConfig(interaction.guildId!) || {};
                
                let paymentInfo = '';
                let paymentName = '';
                let statusName = '';
                
                if (interaction.customId === 'pay_cashapp') {
                  if (!config.cashappTag) return await interaction.followUp({ content: '❌ Cash App is not configured.', flags: MessageFlags.Ephemeral });
                  paymentInfo = `**${config.cashappTag}** on Cash App`;
                  paymentName = 'Cash App';
                  statusName = 'cashapp';
                } else if (interaction.customId === 'pay_venmo') {
                  if (!config.venmoHandle) return await interaction.followUp({ content: '❌ Venmo is not configured.', flags: MessageFlags.Ephemeral });
                  paymentInfo = `**${config.venmoHandle}** on Venmo`;
                  paymentName = 'Venmo';
                  statusName = 'venmo';
                } else if (interaction.customId === 'pay_zelle') {
                  if (!config.zelleEmail) return await interaction.followUp({ content: '❌ Zelle is not configured.', flags: MessageFlags.Ephemeral });
                  paymentInfo = `**${config.zelleEmail}** on Zelle`;
                  paymentName = 'Zelle';
                  statusName = 'zelle';
                } else if (interaction.customId === 'pay_crypto') {
                  if (!config.cryptoAddress) return await interaction.followUp({ content: '❌ Crypto is not configured.', flags: MessageFlags.Ephemeral });
                  paymentInfo = `**${config.cryptoAddress}**`;
                  paymentName = 'Crypto';
                  statusName = 'crypto';
                } else if (interaction.customId === 'pay_paypal') {
                  if (!config.paypalEmail) return await interaction.followUp({ content: '❌ PayPal is not configured.', flags: MessageFlags.Ephemeral });
                  paymentInfo = `**${config.paypalEmail}** on PayPal`;
                  paymentName = 'PayPal';
                  statusName = 'paypal';
                }

                const shortOrderId = state.currentOrderId;

                const guildCashappCookie = config.cashappCookie as string | undefined;
                const sharedEmailCfg = (config.paymentImapEmail && config.paymentImapPassword)
                  ? { email: config.paymentImapEmail as string, password: config.paymentImapPassword as string, host: config.paymentImapHost as string | undefined }
                  : (config.zelleImapEmail && config.zelleImapPassword)
                    ? { email: config.zelleImapEmail as string, password: config.zelleImapPassword as string, host: config.zelleImapHost as string | undefined }
                    : null;
                const willAutoPoll =
                  (statusName === 'cashapp' && (!!guildCashappCookie || !!sharedEmailCfg)) ||
                  (statusName === 'zelle'   && !!sharedEmailCfg) ||
                  (statusName === 'venmo'   && !!sharedEmailCfg) ||
                  (statusName === 'paypal'  && !!sharedEmailCfg);

                const sentBtn = new ButtonBuilder().setCustomId(`${statusName}_sent`).setLabel('✅ I\'ve Sent the Payment').setStyle(ButtonStyle.Success);
                const backBtn = new ButtonBuilder().setCustomId('checkout').setLabel('Back to Payment Options').setStyle(ButtonStyle.Danger);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(sentBtn, backBtn);

                const confirmNote = willAutoPoll
                  ? 'Send the payment then click the button below. The bot is already watching for your payment and will confirm it automatically.'
                  : 'Once you have sent the payment, click the button below. Your order will be sent to the kitchen as soon as the admin verifies the payment.';
                const embed = createEmbed(config)
                  .setTitle(`💸 Pay with ${paymentName}`)
                  .setDescription(`Please send **$${state.totalPrice.toFixed(2)}** to ${paymentInfo}.\n\n**IMPORTANT:** You MUST include this exact Order Number in the "For" / Notes section of your payment:\n\n\`${shortOrderId}\`\n\n${confirmNote}`);

                await interaction.editReply({ content: '', embeds: [embed], components: [row] });

                const stopPoller = (map: typeof cashappPollers, key: string) => {
                  const p = map.get(key);
                  if (p) { clearInterval(p.interval); clearTimeout(p.timeout); map.delete(key); }
                };

                // ── Cash App cookie poll (legacy — kept for backward compat) ─────────
                if (statusName === 'cashapp' && guildCashappCookie && !sharedEmailCfg) {
                  const orderRef = db.collection('orders').doc(shortOrderId);
                  await orderRef.update({ status: 'pending_cashapp' });
                  state.stripeInteraction = interaction;

                  const pollerKey    = `cashapp:${interaction.user.id}:${interaction.guildId!}`;
                  const pollerOrderId = shortOrderId;
                  const pollerAmount  = state.totalPrice;

                  stopPoller(cashappPollers, pollerKey);

                  const runCashAppCheck = async () => {
                    try {
                      const confirmed = await checkCashAppPayment(pollerAmount, pollerOrderId, guildCashappCookie);
                      if (confirmed) { stopPoller(cashappPollers, pollerKey); await fulfillOrder(pollerOrderId, true); return true; }
                    } catch (err) { console.error('Cash App cookie poller error:', err); }
                    return false;
                  };

                  const cashappAlreadyPaid = await runCashAppCheck();
                  if (!cashappAlreadyPaid) {
                    const cashappInterval = setInterval(runCashAppCheck, 15000);
                    const cashappTimeout = setTimeout(() => {
                      stopPoller(cashappPollers, pollerKey);
                      // Alert admin that auto-verify expired without confirming
                      const expiredWebhook = config.webhookUrl;
                      if (expiredWebhook) {
                        fetch(expiredWebhook, {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ content: `⚠️ **Cash App auto-verify expired** for order \`${pollerOrderId}\` ($${pollerAmount.toFixed(2)}). No matching payment was detected after 30 minutes. Please verify manually with \`/admin_orders\`.` }),
                        }).catch(() => {});
                      }
                    }, 30 * 60 * 1000);
                    cashappPollers.set(pollerKey, { interval: cashappInterval, timeout: cashappTimeout });
                  }
                }

                // ── Email-based auto-poll (Cash App, Venmo, Zelle, PayPal) ──────────
                const emailProviders: string[] = ['cashapp', 'venmo', 'zelle', 'paypal'];
                if (emailProviders.includes(statusName) && sharedEmailCfg) {
                  const orderRef = db.collection('orders').doc(shortOrderId);
                  await orderRef.update({ status: `pending_${statusName}` });
                  state.stripeInteraction = interaction;

                  const pollerKey    = `email:${statusName}:${interaction.user.id}:${interaction.guildId!}`;
                  const pollerOrderId = shortOrderId;
                  const pollerAmount  = state.totalPrice;
                  const imapSnap      = { ...sharedEmailCfg };
                  const provider      = statusName as import('./email-payments.ts').PaymentProvider;

                  stopPoller(emailPaymentPollers, pollerKey);

                  const runEmailCheck = async () => {
                    try {
                      const uid = await checkEmailPayment(provider, pollerAmount, pollerOrderId, imapSnap, 45, emailUsedUids);
                      if (uid) {
                        emailUsedUids.add(uid);
                        stopPoller(emailPaymentPollers, pollerKey);
                        await fulfillOrder(pollerOrderId, true);
                        return true;
                      }
                    } catch (err) { console.error(`${statusName} email poller error:`, err); }
                    return false;
                  };

                  // Immediate first check — don't make the user wait 20s
                  const alreadyPaid = await runEmailCheck();
                  if (!alreadyPaid) {
                    const emailInterval = setInterval(runEmailCheck, 20000);
                    const emailTimeout = setTimeout(() => {
                      stopPoller(emailPaymentPollers, pollerKey);
                      // Alert admin that auto-verify expired
                      const expiredWebhook2 = config.webhookUrl;
                      if (expiredWebhook2) {
                        fetch(expiredWebhook2, {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ content: `⚠️ **${statusName} email auto-verify expired** for order \`${pollerOrderId}\` ($${pollerAmount.toFixed(2)}). No matching payment email was found after 35 minutes. Please verify manually with \`/admin_orders\`.` }),
                        }).catch(() => {});
                      }
                    }, 35 * 60 * 1000);
                    emailPaymentPollers.set(pollerKey, { interval: emailInterval, timeout: emailTimeout });
                  }
                }
              } catch (err: any) {
                console.error('Manual Payment Error:', err);
                await interaction.followUp({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
              }
            } else if (['cashapp_sent', 'venmo_sent', 'zelle_sent', 'crypto_sent', 'paypal_sent'].includes(interaction.customId)) {
              try {
                await interaction.deferUpdate();

                let statusName = interaction.customId.replace('_sent', '');
                let paymentName = statusName === 'cashapp' ? 'Cash App' : statusName.charAt(0).toUpperCase() + statusName.slice(1);

                const config = await getGuildConfig(interaction.guildId!) || {};
                const guildCashappCookie2 = config.cashappCookie as string | undefined;
                const hasEmailCfg = !!(config.paymentImapEmail && config.paymentImapPassword) || !!(config.zelleImapEmail && config.zelleImapPassword);
                const willAutoPoll =
                  (statusName === 'cashapp' && (!!guildCashappCookie2 || hasEmailCfg)) ||
                  (statusName === 'zelle'   && hasEmailCfg) ||
                  (statusName === 'venmo'   && hasEmailCfg) ||
                  (statusName === 'paypal'  && hasEmailCfg);

                // For manual methods (no auto-poll), update status now
                if (!willAutoPoll) {
                  const orderRef = db.collection('orders').doc(state.currentOrderId);
                  await orderRef.update({ status: `pending_${statusName}` });
                }

                const autoPaymentName = statusName === 'cashapp' ? 'Cash App' : statusName === 'venmo' ? 'Venmo' : statusName === 'paypal' ? 'PayPal' : 'Zelle';
                const embedDesc = willAutoPoll
                  ? `Thank you! The bot is already watching for your ${autoPaymentName} payment and will confirm it automatically.\n\nOrder Number: \`${state.currentOrderId}\``
                  : `Thank you! Your order is now awaiting manual verification.\n\nOnce the admin confirms receipt of your ${paymentName} payment with Order Number \`${state.currentOrderId}\`, your order will be sent to the kitchen and you will be notified.`;

                const embed = createEmbed(config)
                  .setTitle('⏳ Payment Verification Pending')
                  .setDescription(embedDesc);

                const callStaffBtn = new ButtonBuilder()
                  .setCustomId('call_staff')
                  .setLabel('📣 Call for Staff')
                  .setStyle(ButtonStyle.Secondary);
                const pendingRow = new ActionRowBuilder<ButtonBuilder>().addComponents(callStaffBtn);

                await interaction.editReply({ content: '', embeds: [embed], components: [pendingRow] });

                // Update stored interaction so fulfillOrder updates this screen when payment is confirmed
                state.stripeInteraction = interaction;

                // Kick off an immediate check now that the user has confirmed they sent payment
                if (willAutoPoll) {
                  const sentConfig = await getGuildConfig(interaction.guildId!) || {};
                  const sentEmailCfg = (sentConfig.paymentImapEmail && sentConfig.paymentImapPassword)
                    ? { email: sentConfig.paymentImapEmail as string, password: sentConfig.paymentImapPassword as string, host: sentConfig.paymentImapHost as string | undefined }
                    : (sentConfig.zelleImapEmail && sentConfig.zelleImapPassword)
                      ? { email: sentConfig.zelleImapEmail as string, password: sentConfig.zelleImapPassword as string, host: sentConfig.zelleImapHost as string | undefined }
                      : null;
                  if (sentEmailCfg && ['cashapp', 'venmo', 'zelle', 'paypal'].includes(statusName)) {
                    const sentProvider = statusName as import('./email-payments.ts').PaymentProvider;
                    checkEmailPayment(sentProvider, state.totalPrice, state.currentOrderId, sentEmailCfg, 90, emailUsedUids)
                      .then(uid => {
                        if (uid) { emailUsedUids.add(uid); fulfillOrder(state.currentOrderId, true); }
                      })
                      .catch(err => console.error(`${statusName} sent-button immediate check error:`, err));
                  }
                }

                // For non-cashapp manual methods, alert admin
                if (!willAutoPoll) {
                  const guildWebhookUrl = config.webhookUrl;
                  if (guildWebhookUrl) {
                    await fetch(guildWebhookUrl, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ content: `🚨 **ACTION REQUIRED: ${paymentName} Payment Pending!** 🚨\n\n**Order ID:** \`${state.currentOrderId}\`\n**Amount:** $${state.totalPrice.toFixed(2)}\n**User:** <@${interaction.user.id}>\n\nPlease check your ${paymentName} for a payment with this Order ID in the notes. Use \`/admin_orders\` to confirm the payment and send the order to the kitchen.` })
                    }).catch(err => console.error('Failed to send admin alert webhook:', err));
                  }
                }

              } catch (err: any) {
                console.error('Payment Sent Error:', err);
                await interaction.followUp({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
              }
            } else if (interaction.customId === 'check_payment') {
              if (!state.currentOrderId) {
                return await interaction.reply({ content: '❌ No active order found.', flags: MessageFlags.Ephemeral });
              }

              try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const orderId = state.currentOrderId;

                const orderDoc = await db.collection('orders').doc(orderId).get();
                const orderData = orderDoc.data();
                const currentStatus = orderData?.status ?? '';

                // Already fulfilled by admin or previous auto-check
                const isAlreadyConfirmed = currentStatus === 'paid' || currentStatus === 'paid_fulfilled' || state.isFulfilled;

                if (isAlreadyConfirmed) {
                  const success = await fulfillOrder(orderId, false);
                  if (success) {
                    const config = await getGuildConfig(interaction.guildId!) || {};
                    const successMsg = config.successMessage || 'Your order has been sent to the kitchen.';
                    const parsedOrders = safeParseOrders(orderData?.orderData);
                    const orderDetails = formatOrderItems(parsedOrders);
                    const successEmbed = createEmbed(config)
                      .setTitle('🎉 Order Successful!')
                      .setDescription(`${successMsg}\n\n**Your Order Details:**\n${orderDetails}`)
                      .setImage('https://media.giphy.com/media/l0HlUxcWRsqROFAHQ/giphy.gif');
                    return await interaction.editReply({ content: '', embeds: [successEmbed], components: [] });
                  } else {
                    return await interaction.editReply({ content: '❌ Payment confirmed, but there was an error processing your order. Please contact support.', embeds: [] });
                  }
                }

                // Actively re-poll the payment provider on button press
                // This handles the case where the poller has expired or the user just sent payment
                const checkConfig = await getGuildConfig(interaction.guildId!) || {};
                const checkEmailCfg = (checkConfig.paymentImapEmail && checkConfig.paymentImapPassword)
                  ? { email: checkConfig.paymentImapEmail as string, password: checkConfig.paymentImapPassword as string, host: checkConfig.paymentImapHost as string | undefined }
                  : (checkConfig.zelleImapEmail && checkConfig.zelleImapPassword)
                    ? { email: checkConfig.zelleImapEmail as string, password: checkConfig.zelleImapPassword as string, host: checkConfig.zelleImapHost as string | undefined }
                    : null;
                const checkCashappCookie = checkConfig.cashappCookie as string | undefined;

                let activelyFound = false;

                // Determine which provider this order is waiting on
                const emailProviderMap: Record<string, import('./email-payments.ts').PaymentProvider> = {
                  pending_cashapp: 'cashapp',
                  pending_venmo: 'venmo',
                  pending_zelle: 'zelle',
                  pending_paypal: 'paypal',
                };
                const emailProvider = emailProviderMap[currentStatus];

                if (emailProvider && checkEmailCfg) {
                  try {
                    const uid = await checkEmailPayment(emailProvider, state.totalPrice, orderId, checkEmailCfg, 90, emailUsedUids);
                    if (uid) { emailUsedUids.add(uid); activelyFound = true; }
                  } catch (err) { console.error('check_payment email re-poll error:', err); }
                } else if (currentStatus === 'pending_cashapp' && checkCashappCookie) {
                  try {
                    activelyFound = await checkCashAppPayment(state.totalPrice, orderId, checkCashappCookie);
                  } catch (err) { console.error('check_payment cashapp re-poll error:', err); }
                }

                if (activelyFound) {
                  const fulfilled = await fulfillOrder(orderId, true);
                  if (fulfilled) {
                    const config = await getGuildConfig(interaction.guildId!) || {};
                    const successMsg = config.successMessage || 'Your order has been sent to the kitchen.';
                    const parsedOrders = safeParseOrders(orderData?.orderData);
                    const orderDetails = formatOrderItems(parsedOrders);
                    const successEmbed = createEmbed(config)
                      .setTitle('🎉 Order Successful!')
                      .setDescription(`${successMsg}\n\n**Your Order Details:**\n${orderDetails}`)
                      .setImage('https://media.giphy.com/media/l0HlUxcWRsqROFAHQ/giphy.gif');
                    return await interaction.editReply({ content: '', embeds: [successEmbed], components: [] });
                  }
                }

                const providerLabel = emailProvider
                  ? emailProvider.charAt(0).toUpperCase() + emailProvider.slice(1)
                  : currentStatus.includes('cashapp') ? 'Cash App' : 'the payment provider';
                await interaction.editReply({
                  content: `⏳ Payment not yet detected. Make sure you included \`${orderId}\` in the payment notes and try again in a moment. If the issue persists, ask staff for help.`,
                  components: [],
                  embeds: [],
                });
              } catch (err) {
                console.error('Check Payment Error:', err);
                await interaction.editReply({ content: '❌ Error checking payment status. Please try again later.' });
              }
            } else if (interaction.customId === 'call_staff') {
              try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                // Rate-limit: one ping per order per 2 minutes
                const now = Date.now();
                const lastCall = (state as any).lastStaffCall ?? 0;
                const cooldownMs = 2 * 60 * 1000;
                if (now - lastCall < cooldownMs) {
                  const secsLeft = Math.ceil((cooldownMs - (now - lastCall)) / 1000);
                  return await interaction.editReply({ content: `⏳ Staff was already notified. Please wait ${secsLeft}s before calling again.` });
                }
                (state as any).lastStaffCall = now;

                const config = await getGuildConfig(interaction.guildId!) || {};
                const guildWebhookUrl = config.webhookUrl;
                const staffPing = config.staffRoleId ? `<@&${config.staffRoleId}> ` : '';

                if (guildWebhookUrl) {
                  const orderId = state.currentOrderId;
                  await fetch(guildWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      content: `${staffPing}📣 **Staff assistance requested!**\n\n**User:** <@${interaction.user.id}>\n**Order ID:** \`${orderId}\`\n\nThe customer is waiting for manual payment verification. Use \`/admin_orders\` to confirm.`
                    })
                  }).catch(err => console.error('Failed to send staff ping webhook:', err));
                  await interaction.editReply({ content: '✅ Staff has been notified! Someone will assist you shortly.' });
                } else {
                  await interaction.editReply({ content: '❌ No webhook is configured — staff cannot be alerted automatically. Please contact an admin directly.' });
                }
              } catch (err: any) {
                console.error('Call Staff Error:', err);
                await interaction.editReply({ content: '❌ Something went wrong. Please contact an admin directly.' });
              }
            } else if (interaction.customId.startsWith('deposit_pay_')) {
              // Deposit: user selected payment method
              try {
                await interaction.deferUpdate();
                const method = interaction.customId.replace('deposit_pay_', '') as 'cashapp' | 'venmo' | 'zelle' | 'paypal';
                state.pendingDepositMethod = method;
                const depositId = (state as any).pendingDepositId;
                const depositAmount: number = (state as any).pendingDepositAmount;
                if (!depositId || !depositAmount) return await interaction.followUp({ content: '❌ Deposit session expired. Run `/deposit` again.', flags: MessageFlags.Ephemeral });

                const config = await getGuildConfig(interaction.guildId!) || {};
                let payInfo = '';
                if (method === 'cashapp' && config.cashappTag) payInfo = `**${config.cashappTag}** on Cash App`;
                else if (method === 'venmo' && config.venmoHandle) payInfo = `**${config.venmoHandle}** on Venmo`;
                else if (method === 'zelle' && config.zelleEmail) payInfo = `**${config.zelleEmail}** on Zelle`;
                else if (method === 'paypal' && config.paypalEmail) payInfo = `**${config.paypalEmail}** on PayPal`;
                else return await interaction.followUp({ content: `❌ ${method} is not configured on this server.`, flags: MessageFlags.Ephemeral });

                const sentBtn = new ButtonBuilder().setCustomId('deposit_sent').setLabel('✅ I Sent the Payment').setStyle(ButtonStyle.Success);
                const embed = createEmbed(config)
                  .setTitle('💳 Deposit — Send Payment')
                  .setDescription(`Send **$${depositAmount.toFixed(2)}** to ${payInfo}.\n\n**IMPORTANT:** Include this exact Deposit ID in the notes/memo:\n\`\`\`${depositId}\`\`\`\nOnce sent, click the button below. Your wallet will be credited automatically when the payment is detected.`);
                await interaction.editReply({ content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(sentBtn)] });
              } catch (err: any) {
                console.error('deposit_pay error:', err);
                await interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
              }

            } else if (interaction.customId === 'deposit_sent') {
              // Deposit: user confirmed they sent payment — start polling
              try {
                await interaction.deferUpdate();
                const depositId: string = (state as any).pendingDepositId;
                const depositAmount: number = (state as any).pendingDepositAmount;
                const depositMethod: string = (state as any).pendingDepositMethod || 'cashapp';
                if (!depositId || !depositAmount) return await interaction.followUp({ content: '❌ Deposit session expired. Run `/deposit` again.', flags: MessageFlags.Ephemeral });

                const config = await getGuildConfig(interaction.guildId!) || {};
                const emailCfg = (config.paymentImapEmail && config.paymentImapPassword)
                  ? { email: config.paymentImapEmail as string, password: config.paymentImapPassword as string, host: config.paymentImapHost as string | undefined }
                  : (config.zelleImapEmail && config.zelleImapPassword)
                    ? { email: config.zelleImapEmail as string, password: config.zelleImapPassword as string, host: config.zelleImapHost as string | undefined }
                    : null;
                const cashappCookie = config.cashappCookie as string | undefined;

                // Save pending deposit to Firestore
                const depositRef = db.collection('guilds').doc(interaction.guildId!).collection('deposits').doc(depositId);
                await depositRef.set({
                  userId: interaction.user.id,
                  guildId: interaction.guildId,
                  amount: depositAmount,
                  method: depositMethod,
                  status: 'pending',
                  createdAt: serverTimestamp(),
                });

                const stopDepositPoller = (key: string) => {
                  const p = depositPollers.get(key);
                  if (p) { clearInterval(p.interval); clearTimeout(p.timeout); depositPollers.delete(key); }
                };

                const creditWallet = async () => {
                  const customerRef = db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id);
                  await db.runTransaction(async (txn) => {
                    const doc = await txn.get(customerRef);
                    const bal: number = doc.exists ? (doc.data()?.creditBalance || 0) : 0;
                    const newBal = Math.round((bal + depositAmount) * 100) / 100;
                    txn.set(customerRef, { userId: interaction.user.id, creditBalance: newBal, lastCreditReason: `Deposit ${depositId}`, lastCreditAdjustment: serverTimestamp() }, { merge: true });
                  });
                  await depositRef.update({ status: 'confirmed' });
                  // Notify user
                  try {
                    const customerDoc2 = await db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id).get();
                    const finalBal: number = customerDoc2.data()?.creditBalance || 0;
                    const dm = await interaction.user.createDM();
                    await dm.send(`✅ **${interaction.guild?.name}**: Your deposit of **$${depositAmount.toFixed(2)}** was confirmed! Your wallet balance is now **$${finalBal.toFixed(2)}**.`);
                  } catch {}
                };

                const pollerKey = `deposit:${interaction.user.id}:${interaction.guildId}`;
                stopDepositPoller(pollerKey);

                const runDepositCheck = async (): Promise<boolean> => {
                  try {
                    const provider = depositMethod as import('./email-payments.ts').PaymentProvider;
                    if (emailCfg && ['cashapp', 'venmo', 'zelle', 'paypal'].includes(depositMethod)) {
                      const uid = await checkEmailPayment(provider, depositAmount, depositId, emailCfg, 90, emailUsedUids);
                      if (uid) { emailUsedUids.add(uid); stopDepositPoller(pollerKey); await creditWallet(); return true; }
                    } else if (depositMethod === 'cashapp' && cashappCookie) {
                      const found = await checkCashAppPayment(depositAmount, depositId, cashappCookie);
                      if (found) { stopDepositPoller(pollerKey); await creditWallet(); return true; }
                    }
                  } catch (err) { console.error('deposit poller error:', err); }
                  return false;
                };

                const alreadyPaid = await runDepositCheck();
                if (!alreadyPaid) {
                  const interval = setInterval(runDepositCheck, 20000);
                  const timeout = setTimeout(() => {
                    stopDepositPoller(pollerKey);
                    depositRef.update({ status: 'expired' }).catch(() => {});
                    const wh = config.webhookUrl as string | undefined;
                    if (wh) fetch(wh, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `⚠️ Deposit \`${depositId}\` ($${depositAmount.toFixed(2)}) by <@${interaction.user.id}> expired without payment detected.` }) }).catch(() => {});
                  }, 35 * 60 * 1000);
                  depositPollers.set(pollerKey, { interval, timeout });
                }

                const checkBtn = new ButtonBuilder().setCustomId('deposit_check').setLabel('🔍 Check Payment').setStyle(ButtonStyle.Secondary);
                const embed2 = createEmbed(config)
                  .setTitle('⏳ Deposit Pending Verification')
                  .setDescription(`The bot is watching for your **$${depositAmount.toFixed(2)}** payment.\n\n**Deposit ID:** \`${depositId}\`\n\nYour wallet will be credited automatically once the payment is detected. This usually takes under a minute.`);
                await interaction.editReply({ content: '', embeds: [embed2], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(checkBtn)] });
              } catch (err: any) {
                console.error('deposit_sent error:', err);
                await interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
              }

            } else if (interaction.customId === 'deposit_check') {
              // Deposit: user manually re-checks payment
              try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const depositId: string = (state as any).pendingDepositId;
                const depositAmount: number = (state as any).pendingDepositAmount;
                const depositMethod: string = (state as any).pendingDepositMethod || 'cashapp';
                if (!depositId) return await interaction.editReply({ content: '❌ Deposit session expired. Run `/deposit` again.' });

                // Check Firestore status first
                const depositRef2 = db.collection('guilds').doc(interaction.guildId!).collection('deposits').doc(depositId);
                const depositDoc = await depositRef2.get();
                if (depositDoc.data()?.status === 'confirmed') {
                  const cdoc = await db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id).get();
                  const bal: number = cdoc.data()?.creditBalance || 0;
                  return await interaction.editReply({ content: `✅ Payment already confirmed! Your wallet balance is **$${bal.toFixed(2)}**.` });
                }

                const config2 = await getGuildConfig(interaction.guildId!) || {};
                const emailCfg2 = (config2.paymentImapEmail && config2.paymentImapPassword)
                  ? { email: config2.paymentImapEmail as string, password: config2.paymentImapPassword as string, host: config2.paymentImapHost as string | undefined }
                  : (config2.zelleImapEmail && config2.zelleImapPassword)
                    ? { email: config2.zelleImapEmail as string, password: config2.zelleImapPassword as string, host: config2.zelleImapHost as string | undefined }
                    : null;
                const cashappCookie2 = config2.cashappCookie as string | undefined;
                let found2 = false;
                const provider2 = depositMethod as import('./email-payments.ts').PaymentProvider;

                if (emailCfg2 && ['cashapp', 'venmo', 'zelle', 'paypal'].includes(depositMethod)) {
                  const uid2 = await checkEmailPayment(provider2, depositAmount, depositId, emailCfg2, 90, emailUsedUids).catch(() => null);
                  if (uid2) { emailUsedUids.add(uid2); found2 = true; }
                } else if (depositMethod === 'cashapp' && cashappCookie2) {
                  found2 = await checkCashAppPayment(depositAmount, depositId, cashappCookie2).catch(() => false);
                }

                if (found2) {
                  // Credit wallet
                  const customerRef2 = db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id);
                  await db.runTransaction(async (txn) => {
                    const d = await txn.get(customerRef2);
                    const b: number = d.exists ? (d.data()?.creditBalance || 0) : 0;
                    txn.set(customerRef2, { userId: interaction.user.id, creditBalance: Math.round((b + depositAmount) * 100) / 100, lastCreditReason: `Deposit ${depositId}`, lastCreditAdjustment: serverTimestamp() }, { merge: true });
                  });
                  await depositRef2.update({ status: 'confirmed' });
                  const pollerKey2 = `deposit:${interaction.user.id}:${interaction.guildId}`;
                  const p2 = depositPollers.get(pollerKey2);
                  if (p2) { clearInterval(p2.interval); clearTimeout(p2.timeout); depositPollers.delete(pollerKey2); }
                  const cdoc2 = await db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(interaction.user.id).get();
                  const finalBal2: number = cdoc2.data()?.creditBalance || 0;
                  await interaction.editReply({ content: `✅ Payment detected! **$${depositAmount.toFixed(2)}** added to your wallet. New balance: **$${finalBal2.toFixed(2)}**.` });
                } else {
                  await interaction.editReply({ content: `⏳ Payment not yet detected. Make sure you included \`${depositId}\` in the payment notes and try again shortly.` });
                }
              } catch (err: any) {
                console.error('deposit_check error:', err);
                await interaction.editReply({ content: `❌ ${err.message}` });
              }

            } else if (interaction.customId === 'back_to_review') {
              if (state.editingIndex !== null && state.editingIndex !== undefined) {
                state.orders.splice(state.editingIndex, 0, state.currentOrder);
                state.editingIndex = null;
              }
              await showReview(interaction, state);
            } else if (interaction.customId === 'back_to_entree') {
              await showEntreeSelect(interaction, state);
            } else if (interaction.customId === 'back_to_protein_select') {
              await showProteinSelect(interaction, state);
            } else if (interaction.customId === 'back_to_protein_portion') {
              await showProteinPortion(interaction, state);
            } else if (interaction.customId === 'back_to_rice_select') {
              await showRiceSelect(interaction, state);
            } else if (interaction.customId === 'back_to_rice_portion') {
              await showRicePortion(interaction, state);
            } else if (interaction.customId === 'back_to_beans_select') {
              await showBeansSelect(interaction, state);
            } else if (interaction.customId === 'back_to_beans_portion') {
              await showBeansPortion(interaction, state);
            } else if (interaction.customId === 'back_to_premium') {
              // Only pop from cart if we haven't already restored the current order
              if (!state.currentOrder?.type && state.orders.length > 0) {
                state.currentOrder = state.orders.pop();
              }
              await showPremiumSelect(interaction, state);
            } else if (interaction.customId.startsWith('back_to_topping_')) {
              const index = parseInt(interaction.customId.split('_')[3]);
              await showToppingPortion(interaction, state, index);
            } else if (interaction.customId === 'back_to_toppings_select') {
              await showToppingsSelect(interaction, state);
            }
          }
        }
      } catch (error) {
        console.error('Interaction Error:', error);
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: '❌ An error occurred while processing your request.', flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: '❌ An error occurred while processing your request.', flags: MessageFlags.Ephemeral });
          }
        }
      }
    });

    // Login to Discord
    await client.login(token);
  } catch (error) {
    console.error('❌ Failed to initialize Discord bot:', error);
  }
}

// ─── Cash App browser auto-capture ───────────────────────────────────────────

function findChromePath(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function captureCashAppCookieViaBrowser(): Promise<string | null> {
  const chromePath = findChromePath();
  if (!chromePath) return null;

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=480,720',
      '--window-position=100,100',
    ],
    defaultViewport: null,
  });

  const [page] = await browser.pages();
  await page.goto('https://cash.app/login', { waitUntil: 'domcontentloaded' });

  // Add a status banner so the admin knows what this window is for
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#6d28d9;color:#fff;font-size:13px;font-family:system-ui,sans-serif;padding:8px 12px;text-align:center';
    bar.textContent = '🌯 Burrito Bot — Log in to Cash App. The window will close automatically.';
    document.body.prepend(bar);
  }).catch(() => {});

  return new Promise((resolve) => {
    const POLL_MS = 5000;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const started = Date.now();

    const poll = setInterval(async () => {
      try {
        if (!browser.connected) { clearInterval(poll); resolve(null); return; }
        if (Date.now() - started > TIMEOUT_MS) { clearInterval(poll); await browser.close().catch(() => {}); resolve(null); return; }

        const cookies = await page.cookies('https://cash.app');
        const match = cookies.find(c => c.name === 'cash_web_session');
        if (match) {
          clearInterval(poll);
          // Show success banner before closing
          await page.evaluate(() => {
            const bar = document.querySelector('div[style*="6d28d9"]') as HTMLElement | null;
            if (bar) { bar.style.background = '#059669'; bar.textContent = '✅ Logged in! Closing window…'; }
          }).catch(() => {});
          setTimeout(() => browser.close().catch(() => {}), 1800);
          resolve(match.value);
        }
      } catch { /* page may be navigating */ }
    }, POLL_MS);

    browser.on('disconnected', () => { clearInterval(poll); resolve(null); });
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Apply JSON body parser for all routes
  app.use(express.json());

  // API routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Dashboard API — returns live stats and recent orders across all guilds
  app.get('/api/dashboard', async (req, res) => {
    try {
      const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const startOfDay = new Date(nowPST.getFullYear(), nowPST.getMonth(), nowPST.getDate(), 0, 0, 0);

      // Today's orders, all-time paid, and recent 15 — fetched in parallel
      const [todaySnap, allSnap, recentSnap] = await Promise.all([
        db.collection('orders').where('createdAt', '>=', startOfDay).get(),
        db.collection('orders').where('status', 'in', ['paid', 'paid_fulfilled']).get(),
        db.collection('orders').orderBy('createdAt', 'desc').limit(15).get(),
      ]);
      let todayRevenue = 0;
      let todayEntrees = 0;
      let todayPendingCount = 0;
      let todayPendingRevenue = 0;
      let todayFulfilledCount = 0;
      const statusBreakdown: Record<string, number> = {};
      const topItemsMap: Record<string, number> = {};

      todaySnap.docs.forEach(doc => {
        const d = doc.data();
        const status = d.status || 'pending';
        if (d.totalPrice) todayRevenue += d.totalPrice;
        const items = safeParseOrders(d.orderData);
        todayEntrees += items.length;
        statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
        if (status.startsWith('pending')) {
          todayPendingCount++;
          todayPendingRevenue += d.totalPrice || 0;
        }
        if (status === 'paid_fulfilled') todayFulfilledCount++;
        items.forEach((item: any) => {
          const name = item.type || 'Unknown';
          topItemsMap[name] = (topItemsMap[name] || 0) + 1;
        });
      });

      const topItems = Object.entries(topItemsMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, count]) => ({ name, count }));

      const proteinMap: Record<string, number> = {};
      todaySnap.docs.forEach(doc => {
        const items = safeParseOrders(doc.data().orderData);
        items.forEach((item: any) => {
          (item.proteins || []).forEach((p: string) => {
            proteinMap[p] = (proteinMap[p] || 0) + 1;
          });
        });
      });
      const topProteins = Object.entries(proteinMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }));

      // All-time
      let allRevenue = 0;
      allSnap.docs.forEach(doc => {
        const d = doc.data();
        if (d.totalPrice) allRevenue += d.totalPrice;
      });
      const recentOrders = recentSnap.docs.map(doc => {
        const d = doc.data();
        const items = safeParseOrders(d.orderData);
        const info = safeParseUserInfo(d.userInfo);
        const guildName = d.guildId ? (client.guilds.cache.get(d.guildId)?.name || null) : null;
        return {
          id: doc.id.slice(0, 8),
          status: d.status || 'pending',
          total: d.totalPrice || 0,
          items: items.map((i: any) => i.type).join(', ') || 'Unknown',
          name: info?.name || null,
          guildName,
          createdAt: d.createdAt?.toDate().toISOString() || null,
          guildId: d.guildId || null,
        };
      });

      // Bot info
      const botUser = client.user;
      const guildCount = client.guilds.cache.size;

      res.json({
        bot: {
          online: !!botUser,
          username: botUser?.username || 'Offline',
          tag: botUser?.tag || '',
          guildCount,
        },
        today: {
          orders: todaySnap.size,
          revenue: todayRevenue,
          entrees: todayEntrees,
          pendingCount: todayPendingCount,
          pendingRevenue: todayPendingRevenue,
          fulfilledCount: todayFulfilledCount,
          avgOrderValue: todaySnap.size > 0 ? todayRevenue / todaySnap.size : 0,
          statusBreakdown,
        },
        allTime: {
          orders: allSnap.size,
          revenue: allRevenue,
          avgOrderValue: allSnap.size > 0 ? allRevenue / allSnap.size : 0,
        },
        topItems,
        topProteins,
        recentOrders,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Dashboard API error:', err);
      res.status(500).json({ error: 'Failed to load dashboard data' });
    }
  });

  // Pending orders
  app.get('/api/dashboard/pending', async (req, res) => {
    try {
      const snap = await db.collection('orders')
        .where('status', 'in', ['pending', 'pending_venmo', 'pending_cashapp', 'pending_zelle', 'pending_crypto', 'pending_paypal'])
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      const orders = snap.docs.map(doc => {
        const d = doc.data();
        const items = safeParseOrders(d.orderData);
        const info = safeParseUserInfo(d.userInfo);
        const guildName = d.guildId ? (client.guilds.cache.get(d.guildId)?.name || null) : null;
        return {
          id: doc.id,
          shortId: doc.id.slice(0, 8),
          status: d.status || 'pending',
          total: d.totalPrice || 0,
          items: items.map((i: any) => `${i.type}${i.proteins?.length ? ` (${i.proteins.join(', ')})` : ''}`).join(' · ') || 'Unknown',
          name: info?.name || null,
          phone: info?.phone || null,
          email: info?.email || null,
          location: info?.location || null,
          time: info?.time || null,
          guildName,
          guildId: d.guildId || null,
          createdAt: d.createdAt?.toDate().toISOString() || null,
        };
      });
      res.json({ orders });
    } catch (err) {
      console.error('Pending orders API error:', err);
      res.status(500).json({ error: 'Failed to load pending orders' });
    }
  });

  // Fulfill order from dashboard
  app.post('/api/dashboard/orders/:id/fulfill', async (req, res) => {
    try {
      const success = await fulfillOrder(req.params.id);
      if (success) res.json({ ok: true });
      else res.status(500).json({ error: 'Failed to fulfill order' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cancel order from dashboard
  app.post('/api/dashboard/orders/:id/cancel', async (req, res) => {
    try {
      await db.collection('orders').doc(req.params.id).update({ status: 'cancelled' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7-day revenue trend
  app.get('/api/dashboard/trend', async (req, res) => {
    try {
      const days: { date: string; label: string; orders: number; revenue: number }[] = [];
      for (let i = 6; i >= 0; i--) {
        const base = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
        base.setHours(0, 0, 0, 0);
        base.setDate(base.getDate() - i);
        const end = new Date(base);
        end.setHours(23, 59, 59, 999);
        const snap = await db.collection('orders').where('createdAt', '>=', base).where('createdAt', '<=', end).get();
        let revenue = 0;
        snap.docs.forEach(doc => { const d = doc.data(); if (d.totalPrice) revenue += d.totalPrice; });
        days.push({
          date: base.toISOString(),
          label: base.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
          orders: snap.size,
          revenue,
        });
      }
      res.json({ days });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load trend data' });
    }
  });

  // Per-server stats
  app.get('/api/dashboard/servers', async (req, res) => {
    try {
      const snap = await db.collection('orders').get();
      const serverMap: Record<string, { guildId: string; orders: number; revenue: number; pending: number; fulfilled: number }> = {};
      snap.docs.forEach(doc => {
        const d = doc.data();
        const gid = d.guildId;
        if (!gid) return;
        if (!serverMap[gid]) serverMap[gid] = { guildId: gid, orders: 0, revenue: 0, pending: 0, fulfilled: 0 };
        serverMap[gid].orders++;
        serverMap[gid].revenue += d.totalPrice || 0;
        if ((d.status || '').startsWith('pending')) serverMap[gid].pending++;
        if (d.status === 'paid_fulfilled') serverMap[gid].fulfilled++;
      });
      const servers = await Promise.all(
        Object.values(serverMap).map(async s => {
          const guild = client.guilds.cache.get(s.guildId);
          const config = await getGuildConfig(s.guildId) || {};
          return {
            ...s,
            name: guild?.name || s.guildId,
            memberCount: guild?.memberCount ?? null,
            storeOpen: config.storeOpen !== false,
          };
        })
      );
      servers.sort((a, b) => b.orders - a.orders);
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load server stats' });
    }
  });

  // Toggle store open/close
  app.post('/api/dashboard/servers/:guildId/toggle', async (req, res) => {
    try {
      const { guildId } = req.params;
      const config = await getGuildConfig(guildId) || {};
      const newOpen = config.storeOpen === false ? true : false;
      await updateGuildConfig(guildId, { ...config, storeOpen: newOpen });
      res.json({ storeOpen: newOpen });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Fulfill all paid orders for a guild (mirrors /fulfillall Discord command)
  app.post('/api/dashboard/servers/:guildId/fulfillall', async (req, res) => {
    try {
      const { guildId } = req.params;
      const snap = await db.collection('orders').where('status', '==', 'paid').where('guildId', '==', guildId).get();
      if (snap.empty) return res.json({ fulfilled: 0 });
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        await db.collection('orders').doc(doc.id).update({ status: 'paid_fulfilled' });
        count++;
        // Notify the customer via DM
        if (d.userId) {
          try {
            const user = await client.users.fetch(d.userId);
            await user.send('✅ Your Chipotle order has been fulfilled and is on its way!');
          } catch { /* DM failed — user may have DMs off */ }
        }
      }
      res.json({ fulfilled: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pause / resume a round for a guild
  app.post('/api/dashboard/servers/:guildId/rounds', async (req, res) => {
    try {
      const { guildId } = req.params;
      const { round, action } = req.body; // round: 1-4|'all', action: 'pause'|'resume'
      const config = await getGuildConfig(guildId) || {};
      let pausedRounds: number[] = config.pausedRounds || [];
      const affected = round === 'all' ? [1, 2, 3, 4] : [parseInt(round, 10)];
      if (action === 'pause') {
        for (const r of affected) if (!pausedRounds.includes(r)) pausedRounds.push(r);
      } else {
        pausedRounds = pausedRounds.filter(r => !affected.includes(r));
      }
      await updateGuildConfig(guildId, { ...config, pausedRounds });
      res.json({ pausedRounds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get guild config
  app.get('/api/dashboard/config/:guildId', async (req, res) => {
    try {
      const config = await getGuildConfig(req.params.guildId) || {};
      res.json({ config });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update guild config (price, payment methods)
  app.post('/api/dashboard/config/:guildId', async (req, res) => {
    try {
      const { guildId } = req.params;
      const existing = await getGuildConfig(guildId) || {};
      await updateGuildConfig(guildId, { ...existing, ...req.body });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top customers across all guilds (or per guild via ?guildId=)
  app.get('/api/dashboard/customers', async (req, res) => {
    try {
      const { guildId } = req.query;
      let query: any = db.collection('orders');
      if (guildId) query = query.where('guildId', '==', guildId);
      const snap = await query.get();

      const map: Record<string, { userId: string; orders: number; revenue: number; name: string | null; guildName: string | null }> = {};
      snap.docs.forEach((doc: any) => {
        const d = doc.data();
        const uid = d.userId;
        if (!uid) return;
        // Always aggregate by userId so each customer appears once
        if (!map[uid]) {
          const info = safeParseUserInfo(d.userInfo);
          const gName = d.guildId ? (client.guilds.cache.get(d.guildId)?.name || null) : null;
          map[uid] = { userId: uid, orders: 0, revenue: 0, name: info?.name || null, guildName: gName };
        }
        map[uid].orders++;
        map[uid].revenue += d.totalPrice || 0;
      });

      const customers = Object.values(map)
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 20);

      res.json({ customers });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Extended revenue breakdown (N days of daily data)
  app.get('/api/dashboard/revenue', async (req, res) => {
    try {
      const days = Math.min(parseInt((req.query.days as string) || '30', 10), 90);
      const result: { date: string; label: string; orders: number; revenue: number; entrees: number }[] = [];

      for (let i = days - 1; i >= 0; i--) {
        const base = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
        base.setHours(0, 0, 0, 0);
        base.setDate(base.getDate() - i);
        const end = new Date(base); end.setHours(23, 59, 59, 999);
        const snap = await db.collection('orders').where('createdAt', '>=', base).where('createdAt', '<=', end).get();
        let revenue = 0, entrees = 0;
        snap.docs.forEach((doc: any) => {
          const d = doc.data();
          if (d.totalPrice) revenue += d.totalPrice;
          entrees += safeParseOrders(d.orderData).length;
        });
        result.push({ date: base.toISOString(), label: base.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), orders: snap.size, revenue, entrees });
      }
      res.json({ days: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get blacklist for a guild
  app.get('/api/dashboard/blacklist/:guildId', async (req, res) => {
    try {
      const snap = await db.collection('guilds').doc(req.params.guildId).collection('blacklist').get();
      const entries = snap.docs.map(doc => ({
        userId: doc.id,
        blockedAt: doc.data().blockedAt?.toDate?.()?.toISOString() || null,
        reason: doc.data().reason || null,
      }));
      res.json({ entries });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove from blacklist
  app.delete('/api/dashboard/blacklist/:guildId/:userId', async (req, res) => {
    try {
      await db.collection('guilds').doc(req.params.guildId).collection('blacklist').doc(req.params.userId).delete();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get credits for a guild
  app.get('/api/dashboard/credits/:guildId', async (req, res) => {
    try {
      const snap = await db.collection('guilds').doc(req.params.guildId).collection('customers').where('creditBalance', '>', 0).get();
      const credits = snap.docs.map(doc => ({
        userId: doc.id,
        balance: doc.data().creditBalance || 0,
        lastReason: doc.data().lastCreditReason || null,
        lastAdjustment: doc.data().lastCreditAdjustment?.toDate?.()?.toISOString() || null,
      }));
      credits.sort((a, b) => b.balance - a.balance);
      res.json({ credits });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adjust credit for a user
  app.post('/api/dashboard/credits/:guildId/:userId', async (req, res) => {
    try {
      const { guildId, userId } = req.params;
      const { amount, reason } = req.body;
      const ref = db.collection('guilds').doc(guildId).collection('customers').doc(userId);
      const doc = await ref.get();
      const current: number = doc.exists ? (doc.data()?.creditBalance || 0) : 0;
      const newBalance = Math.max(0, current + Number(amount));
      await ref.set({ userId, creditBalance: newBalance, lastCreditReason: reason || 'Dashboard adjustment', lastCreditAdjustment: serverTimestamp() }, { merge: true });
      res.json({ balance: newBalance });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export all orders as CSV
  app.get('/api/dashboard/export.csv', async (req, res) => {
    try {
      const { guildId, status } = req.query;
      let query: any = db.collection('orders').orderBy('createdAt', 'desc');
      if (guildId) query = db.collection('orders').where('guildId', '==', guildId).orderBy('createdAt', 'desc');
      const snap = await query.get();

      let csv = 'Order ID,Status,Total,Name,Phone,Email,Location,Pickup Time,Items,Server,Created At\n';
      snap.docs.forEach((doc: any) => {
        const d = doc.data();
        if (status && d.status !== status) return;
        const info = safeParseUserInfo(d.userInfo);
        const items = safeParseOrders(d.orderData).map((i: any) => `${i.type}${i.proteins?.length ? ` (${i.proteins.join('/')})` : ''}`).join('; ');
        const gName = d.guildId ? (client.guilds.cache.get(d.guildId)?.name || d.guildId) : '';
        const esc = (v: any) => `"${String(v || '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
        csv += [doc.id, d.status, d.totalPrice || 0, info?.name, info?.phone, info?.email, info?.location, info?.time, items, gName, d.createdAt?.toDate?.()?.toISOString() || '']
          .map(esc).join(',') + '\n';
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="orders_${Date.now()}.csv"`);
      res.send(csv);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send DM to a user via Discord
  app.post('/api/dashboard/dm', async (req, res) => {
    try {
      const { userId, message } = req.body;
      if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });
      const user = await client.users.fetch(userId);
      await user.send(message);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Settings: per-guild config (Firestore) + bot-level read-only info ────────

  app.get('/api/settings', async (req, res) => {
    try {
      const guildId = req.query.guildId as string | undefined;
      const cfg = guildId ? (await getGuildConfig(guildId) || {}) : {};
      res.json({
        guildId: guildId || null,
        cashappCookieSet: !!(cfg as any).cashappCookie,
        cashappCookiePreview: (cfg as any).cashappCookie
          ? ((cfg as any).cashappCookie as string).slice(0, 24) + '…'
          : '',
        webhookUrl: (cfg as any).webhookUrl || '',
        discordToken: process.env.DISCORD_TOKEN
          ? process.env.DISCORD_TOKEN.slice(0, 20) + '…'
          : '',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      const { guildId, cashappCookie, webhookUrl } = req.body as { guildId?: string; cashappCookie?: string; webhookUrl?: string };
      if (!guildId) return res.status(400).json({ error: 'guildId is required' });

      const existing = await getGuildConfig(guildId) || {};
      const updates: Record<string, any> = { ...existing };

      if (cashappCookie !== undefined) updates.cashappCookie = cashappCookie;
      if (webhookUrl !== undefined) updates.webhookUrl = webhookUrl;

      await updateGuildConfig(guildId, updates);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Commands: list guilds ────────────────────────────────────────────────────

  app.get('/api/dashboard/guilds', (req, res) => {
    const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount }));
    res.json({ guilds });
  });

  // ── Commands: broadcast announcement to all guilds ───────────────────────────

  app.post('/api/dashboard/announce', async (req, res) => {
    try {
      const { message, guildId } = req.body as { message: string; guildId?: string };
      if (!message) return res.status(400).json({ error: 'message required' });

      const targets = guildId
        ? [guildId]
        : client.guilds.cache.map(g => g.id);

      let sent = 0;
      for (const gid of targets) {
        const cfg = await getGuildConfig(gid) || {};
        const url = cfg.webhookUrl;
        if (!url) continue;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message }),
        }).catch(() => {});
        sent++;
      }
      res.json({ ok: true, sent });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Commands: batch management ───────────────────────────────────────────────

  app.get('/api/dashboard/batch/:guildId', async (req, res) => {
    try {
      const { guildId } = req.params;
      const snap = await db.collection('orders')
        .where('guildId', '==', guildId)
        .where('batchStatus', '==', 'pending')
        .get();
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json({ orders });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/dashboard/batch/:guildId/clear', async (req, res) => {
    try {
      const { guildId } = req.params;
      const snap = await db.collection('orders')
        .where('guildId', '==', guildId)
        .where('batchStatus', '==', 'pending')
        .get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.update(d.ref, { batchStatus: 'cleared' }));
      await batch.commit();
      res.json({ ok: true, cleared: snap.size });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Commands: round summary ───────────────────────────────────────────────────

  app.get('/api/dashboard/roundsummary/:guildId', async (req, res) => {
    try {
      const { guildId } = req.params;
      const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const startOfDay = new Date(nowPST.getFullYear(), nowPST.getMonth(), nowPST.getDate(), 0, 0, 0);
      const snap = await db.collection('orders')
        .where('guildId', '==', guildId)
        .where('createdAt', '>=', startOfDay)
        .get();
      const orders = snap.docs.map(d => d.data());
      const summary = {
        total: orders.length,
        paid: orders.filter(o => o.status === 'paid' || o.status === 'paid_fulfilled').length,
        pending: orders.filter(o => (o.status as string).startsWith('pending')).length,
        revenue: orders
          .filter(o => o.status === 'paid' || o.status === 'paid_fulfilled')
          .reduce((s, o) => s + (o.total || 0), 0),
      };
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = createHttpServer(app);

  // ─── WebSocket Terminal ────────────────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: '/terminal' });
  wss.on('connection', (ws) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const ptyProc = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    ptyProc.onData((data: string) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input') ptyProc.write(msg.data);
        if (msg.type === 'resize') ptyProc.resize(msg.cols, msg.rows);
      } catch { /* ignore malformed */ }
    });
    ws.on('close', () => ptyProc.kill());
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\x1b[32m  ✅ Express ready\x1b[0m  →  http://localhost:${PORT}`);
    console.log(`\x1b[2m  Connecting Discord bot…\x1b[0m`);
    initDiscordBot();
  });

  httpServer.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use.`);
      process.exit(1);
    } else {
      console.error('❌ Server error:', e);
    }
  });
}

startServer();


const DEFAULT_HEADER_FORMAT = `Customer: {discord}
Pickup Location: {location}
Pickup Time: {time}
Phone: {phone}
Email: {email}`;

const DEFAULT_ITEM_FORMAT = `Order {#}
{name}
{entree}
{protein}
{rice}
{beans}
{toppings}
{premium}`;

async function handleFormat(interaction: any) {
  const config = await getGuildConfig(interaction.guildId) || {};

  const headerInput = new TextInputBuilder()
    .setCustomId('headerFormat')
    .setLabel('Header Format (customer info)')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(config.orderHeaderFormat || DEFAULT_HEADER_FORMAT)
    .setRequired(true);

  const itemInput = new TextInputBuilder()
    .setCustomId('itemFormat')
    .setLabel('Per-Item Format (one entree)')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(config.orderItemFormat || DEFAULT_ITEM_FORMAT)
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId('format_modal')
    .setTitle('Order Format — Placeholders')
    .addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(headerInput),
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(itemInput)
    );

  await interaction.showModal(modal);
}

async function handleTest(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const config = await getGuildConfig(interaction.guildId!) || {};
  const results: string[] = [];
  let testOrderId: string | null = null;

  try {
    // --- Step 1: Config check ---
    const webhookOk = !!(config.webhookUrl);
    const paymentsConfigured = [config.cashappTag, config.venmoHandle, config.zelleEmail, config.cryptoAddress].filter(Boolean);
    results.push(`**Step 1 — Config**`);
    results.push(`${webhookOk ? '✅' : '⚠️'} Order webhook: ${webhookOk ? 'set' : 'not set'}`);
    results.push(`${paymentsConfigured.length > 0 ? '✅' : '⚠️'} Manual payments: ${paymentsConfigured.length > 0 ? paymentsConfigured.join(', ') : 'none'}`);
    results.push(`${config.basePrice ? '✅' : '⚠️'} Base price: ${config.basePrice ? `$${Number(config.basePrice).toFixed(2)}` : 'using default $5.00'}`);
    results.push('');

    // --- Step 2: Create test order in Firestore ---
    results.push(`**Step 2 — Create test order**`);
    testOrderId = `TEST-${generateShortOrderId()}`;
    const testOrderData = JSON.stringify([
      { type: 'Burrito Bowl', proteins: ['Chicken'], rice: { type: 'White Rice', portion: 'Regular' }, beans: { type: 'Black Beans', portion: 'Regular' }, toppings: [{ type: 'Sour Cream', portion: 'Regular' }, { type: 'Cheese', portion: 'Regular' }], selectedToppings: ['Sour Cream', 'Cheese'], premiums: [] }
    ]);
    const testUserInfo = JSON.stringify({
      name: 'Test User',
      location: 'Test Location — 123 Main St',
      time: '12:00 PM',
      phone: '+1 555-000-0000',
      email: 'test@gmail.com'
    });
    await db.collection('orders').doc(testOrderId).set({
      userId: interaction.user.id,
      guildId: interaction.guildId!,
      orderData: testOrderData,
      userInfo: testUserInfo,
      status: 'pending',
      totalPrice: config.basePrice || 5.00,
      createdAt: serverTimestamp()
    });
    results.push(`✅ Order created: \`${testOrderId}\``);
    results.push('');

    // --- Step 3: Run fulfillOrder ---
    results.push(`**Step 3 — Fulfill order (simulate payment)**`);
    const success = await fulfillOrder(testOrderId, true);
    results.push(success ? '✅ fulfillOrder() succeeded' : '❌ fulfillOrder() returned false');
    results.push('');

    // --- Step 4: Verify Firestore status ---
    results.push(`**Step 4 — Verify Firestore status**`);
    const orderDoc = await db.collection('orders').doc(testOrderId).get();
    const finalStatus = orderDoc.data()?.status;
    results.push(`${finalStatus === 'paid' ? '✅' : '❌'} Order status: \`${finalStatus}\` (expected: \`paid\`)`);
    results.push('');

    // --- Step 5: Cleanup ---
    results.push(`**Step 5 — Cleanup**`);
    await db.collection('orders').doc(testOrderId).delete();
    results.push(`✅ Test order \`${testOrderId}\` deleted`);

  } catch (err: any) {
    results.push(`❌ **Error:** ${err.message}`);
    // Cleanup on error
    if (testOrderId) {
      try { await db.collection('orders').doc(testOrderId).delete(); } catch {}
    }
  }

  const embed = createEmbed(config)
    .setTitle('🧪 Bot Test Results')
    .setDescription(results.join('\n'));

  await interaction.editReply({ embeds: [embed] });
}

async function handleSetup(interaction: any, notice?: string) {
  const config = await getGuildConfig(interaction.guildId) || {};

  const webhookStatus = config.webhookUrl ? '✅ Set' : '❌ Not set';
  const channelStatus = config.statusChannelId ? `✅ <#${config.statusChannelId}>` : '❌ Not set';
  const paymentsArr = [
    config.cashappTag && `Cash App (${config.cashappTag})`,
    config.venmoHandle && `Venmo (@${config.venmoHandle})`,
    config.zelleEmail && `Zelle (${config.zelleEmail})`,
    config.paypalEmail && `PayPal (${config.paypalEmail})`,
    config.cryptoAddress && 'Crypto',
  ].filter(Boolean);
  const paymentsStatus = paymentsArr.length ? `✅ ${paymentsArr.join(', ')}` : '❌ None';
  const pricingStatus = config.basePrice ? `✅ $${Number(config.basePrice).toFixed(2)}/entree${config.bulkPrice ? ` · $${Number(config.bulkPrice).toFixed(2)} bulk @${config.bulkThreshold}+` : ''}` : '⚠️ Default ($5.00)';
  const staffStatus  = config.staffRoleId ? `✅ <@&${config.staffRoleId}>` : '❌ Not set';
  const storeStatus  = config.storeOpen !== false ? '🟢 Open' : '🔴 Closed';
  const cashappAutoStatus = config.cashappCookie ? '✅ Auto-verify on' : '⚠️ Manual confirm';
  const hasEmailCfgSetup = !!(config.paymentImapEmail && config.paymentImapPassword) || !!(config.zelleImapEmail && config.zelleImapPassword);
  const emailVerifyStatus = hasEmailCfgSetup
    ? `✅ Active (${config.paymentImapEmail || config.zelleImapEmail})`
    : '⚠️ Not set — run `/paymentemail setup`';

  const description = notice
    ? `${notice}\n\nConfigure this bot for your server. Click a button below to edit that section.`
    : 'Configure this bot for your server. Click a button below to edit that section.';

  const embed = createEmbed(config)
    .setTitle('⚙️ Server Setup')
    .setDescription(description)
    .addFields(
      { name: '🔗 Order Webhook', value: webhookStatus, inline: true },
      { name: '📢 Status Channel', value: channelStatus, inline: true },
      { name: '💸 Payment Methods', value: paymentsStatus, inline: true },
      { name: '💰 Pricing', value: pricingStatus, inline: true },
      { name: '👥 Staff Role', value: staffStatus, inline: true },
      { name: '🏪 Store Status', value: storeStatus, inline: true },
      { name: '💸 Cash App Auto-Verify', value: cashappAutoStatus, inline: true },
      { name: '📧 Email Payment Verify', value: emailVerifyStatus, inline: true },
    );

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup_webhook').setLabel('🔗 Webhook & Channel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup_payments').setLabel('💸 Payments').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup_pricing').setLabel('💰 Pricing').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup_staff').setLabel('👥 Staff Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_messages').setLabel('💬 Messages').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_branding').setLabel('🎨 Branding').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row1, row2], flags: MessageFlags.Ephemeral });
}

async function handleSetWebhook(interaction: any) {
  const webhookUrl = interaction.options.getString('webhook_url');
  const statusChannel = interaction.options.getChannel('status_channel');

  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    return await interaction.reply({ content: '❌ Invalid webhook URL. Must be a Discord webhook URL (https://discord.com/api/webhooks/...).', flags: MessageFlags.Ephemeral });
  }

  const config = await getGuildConfig(interaction.guildId) || {};
  const updates: any = { ...config, webhookUrl };
  if (statusChannel) updates.statusChannelId = statusChannel.id;

  const success = await updateGuildConfig(interaction.guildId, updates);
  if (success) {
    const channelMsg = statusChannel ? ` Status channel set to **${statusChannel.name}**.` : '';
    await interaction.reply({ content: `✅ Webhook URL saved for this server.${channelMsg}`, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content: '❌ Failed to save webhook URL. Check server logs.', flags: MessageFlags.Ephemeral });
  }
}

async function handleRevenue(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ordersQuery = db.collection('orders').where('status', 'in', ['paid', 'paid_fulfilled']).where('guildId', '==', interaction.guildId);
  const ordersSnapshot = await ordersQuery.get();

  const config = await getGuildConfig(interaction.guildId) || {};
  const basePrice = config.basePrice || 5.00;
  const bulkPrice = config.bulkPrice;
  const bulkThreshold = config.bulkThreshold;

  let totalRevenue = 0;
  let totalOrders = 0;

  ordersSnapshot.docs.forEach(doc => {
    totalOrders++;
    const orderData = doc.data();
    if (orderData.totalPrice) {
      totalRevenue += orderData.totalPrice;
    } else {
      // Fallback for orders placed before totalPrice was stored
      const parsedOrders = safeParseOrders(orderData.orderData);
      const numEntrees = parsedOrders.length;
      const price = (bulkPrice && bulkThreshold && numEntrees >= bulkThreshold) ? bulkPrice : basePrice;
      totalRevenue += numEntrees * price;
    }
  });

  const embed = createEmbed(config)
    .setTitle('📈 Revenue Report')
    .addFields(
      { name: 'Total Orders', value: `${totalOrders}`, inline: true },
      { name: 'Total Revenue', value: `$${totalRevenue.toFixed(2)}`, inline: true }
    )
    .setFooter({ text: 'Use /stats for today\'s breakdown. Use /export for full CSV history.' });

  await interaction.editReply({ embeds: [embed] });
}

async function handleCustomers(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ordersQuery = db.collection('orders').where('guildId', '==', interaction.guildId);
  const ordersSnapshot = await ordersQuery.get();

  const customerCounts = new Map<string, number>();

  ordersSnapshot.docs.forEach(doc => {
    const userId = doc.data().userId;
    if (userId) {
      customerCounts.set(userId, (customerCounts.get(userId) || 0) + 1);
    }
  });

  const sortedCustomers = Array.from(customerCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle('🏆 Top Customers');

  if (sortedCustomers.length === 0) {
    embed.setDescription('No customers found.');
  } else {
    let description = '';
    sortedCustomers.forEach(([userId, count], index) => {
      description += `**${index + 1}.** <@${userId}> - ${count} orders\n`;
    });
    embed.setDescription(description);
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleAnnouncements(interaction: any) {
  const message = interaction.options.getString('message');
  const title = interaction.options.getString('title');
  const channel = interaction.options.getChannel('channel');
  const webhookUrl = interaction.options.getString('webhook_url');
  const imageUrl = interaction.options.getString('image_url');

  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setDescription(message);
    
  if (title) embed.setTitle(title);
  if (imageUrl) embed.setImage(imageUrl);

  try {
    if (webhookUrl) {
      if (!isValidDiscordWebhookUrl(webhookUrl)) {
        return await interaction.reply({ content: '❌ Invalid webhook URL. Must be a Discord webhook URL (https://discord.com/api/webhooks/...).', flags: MessageFlags.Ephemeral });
      }
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
      if (!response.ok) throw new Error(`Webhook failed: ${response.statusText}`);
      await interaction.reply({ content: '✅ Announcement sent via webhook!', flags: MessageFlags.Ephemeral });
    } else if (channel) {
      if (typeof channel.send !== 'function') {
         return await interaction.reply({ content: '❌ Please select a valid text channel.', flags: MessageFlags.Ephemeral });
      }
      await channel.send({ embeds: [embed] });
      await interaction.reply({ content: `✅ Announcement sent to ${channel}!`, flags: MessageFlags.Ephemeral });
    } else {
      // Default to the current channel if neither is provided
      await interaction.channel.send({ embeds: [embed] });
      await interaction.reply({ content: '✅ Announcement sent to this channel!', flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error('Error sending announcement:', error);
    await interaction.reply({ content: '❌ Failed to send announcement. Please check the channel permissions or webhook URL.', flags: MessageFlags.Ephemeral });
  }
}

async function handleFulfillAll(interaction: any) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ordersQuery = db.collection('orders').where('status', '==', 'paid').where('guildId', '==', interaction.guildId);
    const ordersSnapshot = await ordersQuery.get();

    if (ordersSnapshot.empty) {
      return await interaction.editReply({ content: 'No paid orders found to fulfill.' });
    }

    let fulfilledCount = 0;
    let dmSent = 0;
    let dmFailed = 0;

    for (const orderDoc of ordersSnapshot.docs) {
      const orderData = orderDoc.data();
      await db.collection('orders').doc(orderDoc.id).update({ status: 'paid_fulfilled' });
      fulfilledCount++;

      if (orderData?.userId) {
        try {
          console.log(`📨 Attempting DM to user ${orderData.userId}...`);
          const target = await client.users.fetch(orderData.userId);
          await target.send('🎉 Good news! Your order has been fulfilled and is ready for pickup!');
          dmSent++;
          console.log(`✅ DM sent to user ${orderData.userId}`);
        } catch (err: any) {
          dmFailed++;
          console.error(`❌ DM failed for user ${orderData.userId}:`, err?.message ?? err);
        }
      }
    }

    const dmNote = dmFailed > 0
      ? `\n⚠️ ${dmSent} DM(s) sent, ${dmFailed} failed (user(s) may have DMs disabled).`
      : dmSent > 0 ? `\n✉️ ${dmSent} customer(s) notified via DM.` : '';

    await interaction.editReply({ content: `✅ Successfully fulfilled ${fulfilledCount} paid order(s).${dmNote}` });
  } catch (error) {
    console.error('Error fulfilling all orders:', error);
    await interaction.editReply({ content: '❌ An error occurred while fulfilling orders.' });
  }
}

async function handleSetPrice(interaction: any) {
  const standard = interaction.options.getNumber('standard');
  const bulkPrice = interaction.options.getNumber('bulk_price');
  const bulkThreshold = interaction.options.getInteger('bulk_threshold');

  const config = await getGuildConfig(interaction.guildId) || {};
  const newConfig: any = { ...config, basePrice: standard };
  if (bulkPrice !== null) newConfig.bulkPrice = bulkPrice;
  if (bulkThreshold !== null) newConfig.bulkThreshold = bulkThreshold;

  const success = await updateGuildConfig(interaction.guildId, newConfig);
  if (!success) {
    return await interaction.reply({ content: '❌ Failed to update price.', flags: MessageFlags.Ephemeral });
  }

  // Recalculate totalPrice on all unpaid pending orders
  const pendingStatuses = ['pending', 'pending_cashapp', 'pending_venmo', 'pending_zelle', 'pending_crypto', 'pending_paypal'];
  let updatedCount = 0;

  for (const status of pendingStatuses) {
    const ordersQuery = db.collection('orders').where('status', '==', status).where('guildId', '==', interaction.guildId);
    const ordersSnapshot = await ordersQuery.get();

    for (const orderDoc of ordersSnapshot.docs) {
      const orderData = orderDoc.data();
      const parsedOrders = safeParseOrders(orderData.orderData);
      
      const numEntrees = parsedOrders.length;
      const effectiveBase = (bulkPrice && bulkThreshold && numEntrees >= bulkThreshold) ? bulkPrice : standard;
      
      let newTotal = 0;
      parsedOrders.forEach((item: any) => {
        let price = effectiveBase;
        newTotal += price;
      });

      if (newTotal !== orderData.totalPrice) {
        await db.collection('orders').doc(orderDoc.id).update({ totalPrice: newTotal });
        updatedCount++;

        // Notify the customer their price changed
        if (orderData.userId) {
          try {
            const user = await client.users.fetch(orderData.userId);
            await user.send(`ℹ️ Heads up — the price for your pending order \`${orderDoc.id}\` has been updated from **$${orderData.totalPrice.toFixed(2)}** to **$${newTotal.toFixed(2)}** due to a menu price change.`);
          } catch (e) {
            console.error(`Could not notify user ${orderData.userId} of price change:`, e);
          }
        }
      }
    }
  }

  // Also update any active in-memory sessions (users currently building orders)
  // Their prices will be recalculated when they hit showReview or checkout,
  // since those pull config.basePrice dynamically. No action needed.

  let msg = `✅ Standard price updated to **$${standard.toFixed(2)}**.`;
  if (bulkPrice && bulkThreshold) {
    msg += `\n✅ Bulk pricing enabled: **$${bulkPrice.toFixed(2)}** each at **${bulkThreshold}+** entrees.`;
  }
  if (updatedCount > 0) {
    msg += `\n📦 Recalculated prices on **${updatedCount}** pending order(s). Customers have been notified.`;
  }
  await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
}

async function handleSetPayment(interaction: any) {
  const config = await getGuildConfig(interaction.guildId) || {};

  const modal = new ModalBuilder()
    .setCustomId('setpayment_modal')
    .setTitle('Update Payment Methods');

  const venmoInput = new TextInputBuilder()
    .setCustomId('venmo')
    .setLabel('Venmo Username')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (config.venmoHandle) venmoInput.setValue(config.venmoHandle);

  const zelleInput = new TextInputBuilder()
    .setCustomId('zelle')
    .setLabel('Zelle Email/Phone')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (config.zelleEmail) zelleInput.setValue(config.zelleEmail);

  const cashappInput = new TextInputBuilder()
    .setCustomId('cashapp')
    .setLabel('CashApp Tag')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (config.cashappTag) cashappInput.setValue(config.cashappTag);

  const cryptoInput = new TextInputBuilder()
    .setCustomId('crypto')
    .setLabel('Crypto Address (if enabled)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (config.cryptoAddress) cryptoInput.setValue(config.cryptoAddress);

  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(venmoInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(zelleInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(cashappInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(cryptoInput)
  );

  await interaction.showModal(modal);
}

async function handleBranding(interaction: any) {
  const cfg = await getGuildConfig(interaction.guildId!) || {};

  const modal = new ModalBuilder()
    .setCustomId('branding_modal')
    .setTitle('Update Branding');

  const colorInput = new TextInputBuilder()
    .setCustomId('color')
    .setLabel('Embed Color (Hex, e.g., #FF6321)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (cfg.embedColor) colorInput.setValue(cfg.embedColor);

  const nameInput = new TextInputBuilder()
    .setCustomId('displayName')
    .setLabel('Bot Display Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (cfg.botDisplayName) nameInput.setValue(cfg.botDisplayName);

  const footerInput = new TextInputBuilder()
    .setCustomId('footer')
    .setLabel('Footer Text')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (cfg.footerText) footerInput.setValue(cfg.footerText);

  const avatarInput = new TextInputBuilder()
    .setCustomId('avatar')
    .setLabel('Profile Picture URL')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (cfg.avatarUrl) avatarInput.setValue(cfg.avatarUrl);

  const statusInput = new TextInputBuilder()
    .setCustomId('status')
    .setLabel('Bot Status Message')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (cfg.statusMessage) statusInput.setValue(cfg.statusMessage);

  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(colorInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(nameInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(footerInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(avatarInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(statusInput)
  );

  await interaction.showModal(modal);
}

async function announceStoreOpen(guildId: string) {
  const guildConfig = await getGuildConfig(guildId) || {};
  const webhookUrl = guildConfig.webhookUrl;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `@everyone 🟢 **The queue is now OPEN!** Use \`/order\` to place your order.\n\n${QUEUE_SCHEDULE_TEXT}`
      })
    });
  } catch (e) {
    console.error('Failed to post store-open announcement:', e);
  }
}

async function handleStoreStatus(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = await getGuildConfig(interaction.guildId) || {};
  const currentStatus = config.storeOpen !== false;
  const newStatus = !currentStatus;

  await updateGuildConfig(interaction.guildId, { ...config, storeOpen: newStatus });

  if (newStatus) await announceStoreOpen(interaction.guildId);

  await interaction.editReply({
    content: `✅ The store is now **${newStatus ? 'OPEN' : 'CLOSED'}**. Use \`/renamechannel\` to update the status channel name.`
  });
}

async function handleRenameChannel(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const status = interaction.options.getString('status') as 'open' | 'closed';
  const config = await getGuildConfig(interaction.guildId) || {};
  const statusChannelId = config.statusChannelId;

  if (!statusChannelId) {
    return await interaction.editReply({ content: '❌ No status channel configured. Set one in `/setup main` → Webhook & Channel.' });
  }

  try {
    const channel = await interaction.client.channels.fetch(statusChannelId);
    if (!channel || !('setName' in channel)) {
      return await interaction.editReply({ content: '❌ Could not find the configured status channel.' });
    }
    const newName = status === 'open' ? '🟢open🟢' : '🔴closed🔴';
    await (channel as any).setName(newName);
    await interaction.editReply({ content: `✅ Status channel renamed to **${newName}**.` });
  } catch (error) {
    console.error('Failed to rename channel:', error);
    await interaction.editReply({ content: '❌ Failed to rename channel — make sure the bot has **Manage Channels** permission.' });
  }
}

async function handleExport(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const ordersQuery = db.collection('orders').where('guildId', '==', interaction.guildId).orderBy('createdAt', 'desc').limit(1000);
    const ordersSnapshot = await ordersQuery.get();
    
    if (ordersSnapshot.empty) {
      return await interaction.editReply({ content: 'No orders found to export.' });
    }

    let csvContent = 'Order ID,User ID,Status,Total Price,Created At,Name,Location,Time,Phone,Email,Order Details\n';
    
    ordersSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const parsedOrders = safeParseOrders(data.orderData);
      const parsedUserInfo = safeParseUserInfo(data.userInfo);
      
      const orderDetails = parsedOrders.map((o: any) => `${o.type} (${(o.proteins || []).join(', ')})`).join('; ');
      const dateStr = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : 'N/A';
      
      const row = [
        doc.id,
        data.userId || 'N/A',
        data.status || 'N/A',
        data.totalPrice || 0,
        dateStr,
        parsedUserInfo.name || 'N/A',
        parsedUserInfo.location || 'N/A',
        parsedUserInfo.time || 'N/A',
        parsedUserInfo.phone || 'N/A',
        parsedUserInfo.email || 'N/A',
        orderDetails
      ].map(field => `"${String(field).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`).join(',');
      
      csvContent += row + '\n';
    });

    const buffer = Buffer.from(csvContent, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: 'orders_export.csv' });
    
    await interaction.editReply({ content: '✅ Here is your orders export:', files: [attachment] });
  } catch (error) {
    console.error('Error exporting orders:', error);
    await interaction.editReply({ content: '❌ Failed to export orders.' });
  }
}

async function handleMenu(interaction: any) {
  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle('🌯 Chipotle Menu')
    .setDescription('Here\'s what we offer! Use `/order` to start building your meal.')
    .addFields(
      { name: '🍽️ Entrees', value: '🥗 Burrito Bowl · 🌯 Burrito · 🧀 Quesadilla · 🥙 Salad Bowl · 🌮 Tacos' },
      { name: '🥩 Proteins', value: '🍗 Chicken · 🌶️ Chicken Al Pastor · 🥩 Steak · 🐄 Beef Barbacoa · 🐷 Carnitas · 🌱 Sofritas · 🥦 Veggie' },
      { name: '🍚 Rice & 🫘 Beans', value: '🍚 White Rice · 🌾 Brown Rice\n⚫ Black Beans · 🟤 Pinto Beans' },
      { name: '🧂 Toppings', value: '🫑 Fajita Veggies · 🍅 Fresh Tomato Salsa · 🌽 Roasted Chili-Corn Salsa · 🟢 Tomatillo-Green Chili Salsa · 🔴 Tomatillo-Red Chili Salsa · 🥛 Sour Cream · 🧀 Cheese · 🥬 Romaine Lettuce' },
      { name: '⭐ Premiums', value: '🥑 Guacamole · 🫕 Queso Blanco' }
    );
    
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleToggle(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = await getGuildConfig(interaction.guildId) || {};
  const currentStatus = config.storeOpen !== false;
  const newStatus = !currentStatus;

  const success = await updateGuildConfig(interaction.guildId, { ...config, storeOpen: newStatus });
  if (!success) {
    return await interaction.editReply({ content: '❌ Failed to toggle ordering status.' });
  }

  if (newStatus) await announceStoreOpen(interaction.guildId);

  const emoji = newStatus ? '🟢' : '🔴';
  const statusLabel = newStatus ? 'ENABLED' : 'DISABLED';
  const newChannelName = newStatus ? '🟢open🟢' : '🔴closed🔴';

  // Automatically rename the status channel if one is configured
  let channelNote = '';
  const statusChannelId = config.statusChannelId;
  if (statusChannelId) {
    try {
      const channel = await interaction.client.channels.fetch(statusChannelId);
      if (channel && 'setName' in channel) {
        await (channel as any).setName(newChannelName);
        channelNote = `\nStatus channel renamed to **${newChannelName}**.`;
      }
    } catch (e) {
      channelNote = '\n⚠️ Could not rename the status channel — check **Manage Channels** permission.';
    }
  }

  await interaction.editReply({ content: `${emoji} Ordering is now **${statusLabel}**.${channelNote}` });
}

async function handlePending(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pendingStatuses = ['pending', 'pending_cashapp', 'pending_venmo', 'pending_zelle', 'pending_crypto', 'pending_paypal'];
  const allOrders: any[] = [];

  for (const status of pendingStatuses) {
    const snap = await db.collection('orders').where('status', '==', status).where('guildId', '==', interaction.guildId).get();
    snap.docs.forEach(doc => allOrders.push({ id: doc.id, ...doc.data() }));
  }

  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle('🕐 Pending Orders')
    .setDescription(allOrders.length > 0
      ? `There are **${allOrders.length}** pending order(s) awaiting confirmation.`
      : '✅ No pending orders.');

  const EMBED_FIELD_LIMIT = 25;
  if (allOrders.length > 0) {
    const displayOrders = allOrders.slice(0, EMBED_FIELD_LIMIT);
    const overflow = allOrders.length - displayOrders.length;
    displayOrders.forEach((order: any) => {
      const parsedOrders = safeParseOrders(order.orderData);
      const parsedInfo = safeParseUserInfo(order.userInfo);
      const orderDetails = formatOrderItems(parsedOrders);
      const paymentLabel = order.status === 'pending' ? 'Unconfirmed'
        : order.status.replace('pending_', '').replace(/^\w/, (c: string) => c.toUpperCase());
      let fieldValue = `**Customer:** ${parsedInfo?.name || `<@${order.userId}>`}\n${orderDetails}\n**Total:** $${order.totalPrice?.toFixed(2) ?? '—'}`;
      if (fieldValue.length > 1024) fieldValue = fieldValue.slice(0, 1020) + '...';
      embed.addFields({
        name: `Order ${order.id} — ${paymentLabel}`,
        value: fieldValue
      });
    });
    if (overflow > 0) {
      embed.addFields({ name: '...', value: `And **${overflow}** more order(s) not shown. All will be confirmed when you click the button.` });
    }
  }

  const components: any[] = [];
  if (allOrders.length > 0) {
    const confirmAllBtn = new ButtonBuilder()
      .setCustomId('admin_pending_confirm_all')
      .setLabel('✅ Confirm All Pending Orders')
      .setStyle(ButtonStyle.Success);
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(confirmAllBtn));
  }

  await interaction.editReply({ embeds: [embed], components });
}

async function handleSettings(interaction: any) {
  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle('⚙️ Bot Settings')
    .setDescription('Use **`/setup main`** for a full guided configuration dashboard.\n\nIndividual commands:\n\n⚙️ `/setup main` — Full setup (webhook, payments, pricing, staff, branding)\n🔁 `/toggle` — Enable or disable ordering\n📢 `/storestatus` — Open/close the store\n📋 `/format` — Customize order detail format\n🗓️ `/schedule` — View queue schedule');
  
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleBlacklist(interaction: any) {
  const user = interaction.options.getUser('user');
  try {
    const blacklistRef = db.collection('guilds').doc(interaction.guildId).collection('blacklist').doc(user.id);
    const blacklistDoc = await blacklistRef.get();
    
    if (blacklistDoc.exists) {
      // User is currently blacklisted — unblock them
      await blacklistRef.delete();
      await interaction.reply({ content: `✅ User **${user.tag}** has been **removed** from the blacklist.`, flags: MessageFlags.Ephemeral });
    } else {
      // Add user to blacklist
      await blacklistRef.set({
        username: user.tag,
        blockedAt: serverTimestamp()
      });
      await interaction.reply({ content: `🚫 User **${user.tag}** has been **blacklisted**. They will no longer be able to place orders.`, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error('Blacklist error:', err);
    await interaction.reply({ content: '❌ Failed to update blacklist.', flags: MessageFlags.Ephemeral });
  }
}

async function showAdminOrders(interaction: any, status: string) {
  const ordersQuery = db.collection('orders').where('status', '==', status).where('guildId', '==', interaction.guildId);
  const ordersSnapshot = await ordersQuery.get();
  const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle(`📋 Orders — ${status.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}`)
    .setDescription(orders.length > 0 ? `📦 Found **${orders.length}** order(s).` : '✅ No orders found.');

  const row1 = makeSelect('admin_filter_status', 'Filter by status', ORDER_STATUS_OPTIONS);
  const components: any[] = [row1];

  if (orders.length > 0) {
    const orderSelect = new StringSelectMenuBuilder()
      .setCustomId('admin_order_select')
      .setPlaceholder('Select an order to manage')
      .addOptions(
        orders.map((order: any) => ({
          label: `Order ${order.id.slice(0, 8)}`,
          description: `Status: ${order.status}`,
          value: order.id
        }))
      );
    const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(orderSelect);
    components.push(row2);
  }

  if (status.startsWith('pending') && orders.length > 0) {
    let btnId = 'admin_confirm_all_pending';
    let btnLabel = 'Confirm All Pending Orders';
    
    if (status === 'pending_cashapp') {
      btnId = 'admin_confirm_all_cashapp';
      btnLabel = 'Confirm All Cash App Orders';
    } else if (status === 'pending_venmo') {
      btnId = 'admin_confirm_all_venmo';
      btnLabel = 'Confirm All Venmo Orders';
    } else if (status === 'pending_zelle') {
      btnId = 'admin_confirm_all_zelle';
      btnLabel = 'Confirm All Zelle Orders';
    } else if (status === 'pending_paypal') {
      btnId = 'admin_confirm_all_paypal';
      btnLabel = 'Confirm All PayPal Orders';
    } else if (status === 'pending_crypto') {
      btnId = 'admin_confirm_all_crypto';
      btnLabel = 'Confirm All Crypto Orders';
    }

    const confirmAllBtn = new ButtonBuilder()
      .setCustomId(btnId)
      .setLabel(btnLabel)
      .setStyle(ButtonStyle.Success);
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmAllBtn);
    components.push(row3);
  }

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ embeds: [embed], components });
  } else {
    await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
  }
}

async function fulfillOrder(orderId: string, notifyUser: boolean = true) {
  try {
    const orderRef = db.collection('orders').doc(orderId);

    // Use a transaction to atomically check and update status,
    // preventing double-fulfillment from concurrent calls.
    const orderData = await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists) {
        throw new Error(`Order ${orderId} not found in Firestore.`);
      }

      const data = orderDoc.data();
      if (data?.status === 'paid' || data?.status === 'paid_fulfilled') {
        // Already fulfilled — return null to signal no action needed
        return null;
      }

      // Atomically mark as paid inside the transaction
      transaction.update(orderRef, {
        status: 'paid',
        batchStatus: 'pending',
        paidAt: serverTimestamp()
      });

      return data;
    });

    // Already fulfilled
    if (orderData === null) {
      console.log(`Order ${orderId} already fulfilled.`);
      return true;
    }

    const userId = orderData?.userId;
    const guildId = orderData?.guildId;
    const state = orderState.get(`${userId}:${guildId}`);
    const parsedOrders = safeParseOrders(orderData?.orderData);
    const parsedUserInfo = safeParseUserInfo(orderData?.userInfo);

    const fmtConfig = guildId ? (await getGuildConfig(guildId) || {}) : {};
    const discordWebhookUrl = fmtConfig.webhookUrl;
    const payloadText = formatConfirmedOrderPayload(userId, parsedUserInfo, parsedOrders, fmtConfig);

    // Send to kitchen webhook (non-blocking — failure does not prevent DM or screen update)
    if (discordWebhookUrl) {
      try {
        const response = await fetch(discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `**✅ Payment Confirmed! New Chipotle Order!**\n\n${payloadText}` })
        });
        if (response.ok) {
          console.log(`Order successfully sent to Discord Webhook for user ${userId}.`);
        } else {
          console.error(`Discord Webhook failed with status: ${response.status}`);
        }
      } catch (e) {
        console.error('Discord Webhook error:', e);
      }
    } else {
      console.warn('No webhook URL configured — skipping kitchen notification.');
    }

    // Update the customer's Discord screen in place
    const orderDetails = formatOrderItems(parsedOrders);
    let screenUpdated = false;
    const storedInteraction = state?.stripeInteraction;
    if (storedInteraction) {
      try {
        const successMsg = fmtConfig.successMessage || 'Your order has been sent to the kitchen. Thank you for your payment!';
        const successEmbed = createEmbed(fmtConfig)
          .setTitle('✅ Payment Confirmed!')
          .setDescription(`${successMsg}\n\n**Your Order Details:**\n${orderDetails}`)
          .setColor(0x22c55e);
        await storedInteraction.editReply({ content: '', embeds: [successEmbed], components: [] });
        screenUpdated = true;
      } catch (e) {
        console.error('Could not update customer screen after fulfillment (token likely expired):', e);
      }
    }

    if (state) state.isFulfilled = true;

    // Only DM if the in-app screen could not be updated (e.g. interaction token expired after 15 min)
    if (notifyUser && !screenUpdated) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(`✅ Your payment has been confirmed. We are preparing your order!\n\n**Your Order Details:**\n${payloadText}`);
        console.log(`✅ Payment confirmation DM sent to user ${userId} (screen update unavailable).`);
      } catch (e) {
        console.error(`Could not send DM to user ${userId}:`, e);
      }
    }

    // Clean up state
    orderState.delete(`${userId}:${guildId}`);

    return true;
  } catch (err) {
    console.error('Error in fulfillOrder:', err);
    return false;
  }
}












function createPortionRow(prefix: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_Light`).setLabel('✨ Light').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}_Regular`).setLabel('✅ Regular').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}_Extra`).setLabel('💪 Extra').setStyle(ButtonStyle.Secondary),
  );
}

async function showEntreeSelect(interaction: any, state: any) {
  const config = await getGuildConfig(interaction.guildId || state.guildId) || {};
  const entreePrompt = config.entreePrompt || 'Choose your entree:';
  const row = makeSelect('entree_select', 'Choose your entree', [
    { label: '🥗 Burrito Bowl', value: 'Burrito Bowl' },
    { label: '🌯 Burrito', value: 'Burrito' },
    { label: '🧀 Quesadilla', value: 'Quesadilla' },
    { label: '🥙 Salad Bowl', value: 'Salad Bowl' },
    { label: '🌮 Tacos', value: 'Tacos' },
  ]);
  const components: any[] = [row];
  if (state.orders && state.orders.length > 0) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('back_to_review').setLabel('Back to Review').setStyle(ButtonStyle.Danger)
    ));
  }
  const method = interaction.replied || interaction.deferred ? 'editReply' : (interaction.isButton() || interaction.isStringSelectMenu() ? 'update' : 'reply');
  await interaction[method]({ content: entreePrompt, components, embeds: [], flags: MessageFlags.Ephemeral });
}

async function showProteinSelect(interaction: any, state: any) {
  const config = await getGuildConfig(interaction.guildId || state.guildId) || {};
  const proteinPrompt = config.proteinPrompt || 'Now choose your protein:';
  const row = makeSelect('protein_select', 'Choose Protein or Veggie', [
    { label: '🍗 Chicken', value: 'Chicken' },
    { label: '🌶️ Chicken Al Pastor', value: 'Chicken Al Pastor' },
    { label: '🥩 Steak', value: 'Steak' },
    { label: '🐄 Beef Barbacoa', value: 'Beef Barbacoa' },
    { label: '🐷 Carnitas', value: 'Carnitas' },
    { label: '🌱 Sofritas', value: 'Sofritas' },
    { label: '🥦 Veggie', value: 'Veggie' },
  ], { min: 1, max: 1 });
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('back_to_entree').setLabel('Back').setStyle(ButtonStyle.Danger)
  );
  await interaction.update({ content: `Selected: **${state.currentOrder.type}**. ${proteinPrompt}`, components: [row, backRow] });
}

async function showProteinPortion(interaction: any, state: any) {
  const doubleBtn = new ButtonBuilder().setCustomId('protein_double').setLabel('💪 Double Protein').setStyle(ButtonStyle.Primary);
  const skipBtn = new ButtonBuilder().setCustomId('protein_skip').setLabel('✅ Regular Portion').setStyle(ButtonStyle.Secondary);
  const backBtn = new ButtonBuilder().setCustomId('back_to_protein_select').setLabel('◀️ Back').setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(doubleBtn, skipBtn, backBtn);
  await interaction.update({ content: `🥩 Protein: **${state.currentOrder.proteins.join(', ')}**. Would you like double protein?`, components: [row] });
}

async function showRiceSelect(interaction: any, state: any) {
  const row = makeSelect('rice_select', 'Choose Rice', [
    { label: '🍚 White Rice', value: 'White Rice' },
    { label: '🌾 Brown Rice', value: 'Brown Rice' },
    { label: '❌ None', value: 'None' },
  ]);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('back_to_protein_portion').setLabel('◀️ Back').setStyle(ButtonStyle.Danger)
  );
  await interaction.update({ content: '🍚 Choose your rice:', components: [row, backRow] });
}

async function showRicePortion(interaction: any, state: any) {
  const row = createPortionRow('rice_portion');
  const backBtn = new ButtonBuilder().setCustomId('back_to_rice_select').setLabel('Back').setStyle(ButtonStyle.Danger);
  row.addComponents(backBtn);
  await interaction.update({ content: `🍚 Rice: **${state.currentOrder.rice.type}**. Choose portion:`, components: [row] });
}

async function showBeansSelect(interaction: any, state: any) {
  const row = makeSelect('beans_select', 'Choose Beans', [
    { label: '⚫ Black Beans', value: 'Black Beans' },
    { label: '🟤 Pinto Beans', value: 'Pinto Beans' },
    { label: '❌ None', value: 'None' },
  ]);
  const backId = state.currentOrder.rice.type === 'None' ? 'back_to_rice_select' : 'back_to_rice_portion';
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger)
  );
  await interaction.update({ content: '🫘 Choose your beans:', components: [row, backRow] });
}

async function showBeansPortion(interaction: any, state: any) {
  const row = createPortionRow('beans_portion');
  const backBtn = new ButtonBuilder().setCustomId('back_to_beans_select').setLabel('Back').setStyle(ButtonStyle.Danger);
  row.addComponents(backBtn);
  await interaction.update({ content: `🫘 Beans: **${state.currentOrder.beans.type}**. Choose portion:`, components: [row] });
}

async function showToppingsSelect(interaction: any, state: any) {
  const entreeType = state.currentOrder.type;
  const maxToppings = entreeType === 'Quesadilla' ? 2 : entreeType === 'Tacos' ? 4 : 8;
  const row = makeSelect('toppings_select', 'Choose Toppings', [
    { label: '🍅 Fresh Tomato Salsa', value: 'Fresh Tomato Salsa' },
    { label: '🌽 Roasted Chili-Corn Salsa', value: 'Roasted Chili-Corn Salsa' },
    { label: '🟢 Tomatillo-Green Chili Salsa', value: 'Tomatillo-Green Chili Salsa' },
    { label: '🔴 Tomatillo-Red Chili Salsa', value: 'Tomatillo-Red Chili Salsa' },
    { label: '🥛 Sour Cream', value: 'Sour Cream' },
    { label: '🫑 Fajita Veggies', value: 'Fajita Veggies' },
    { label: '🧀 Cheese', value: 'Cheese' },
    { label: '🥬 Romaine Lettuce', value: 'Romaine Lettuce' },
  ], { min: 0, max: maxToppings });
  const backId = state.currentOrder.beans.type === 'None' ? 'back_to_beans_select' : 'back_to_beans_portion';
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger)
  );
  await interaction.update({ content: '🥗 Choose your toppings (select all that apply):', components: [row, backRow] });
}

async function showToppingPortion(interaction: any, state: any, index: number) {
  const topping = state.currentOrder.selectedToppings[index];
  const row = createPortionRow(`topping_portion_${index}`);
  const backId = index === 0 ? 'back_to_toppings_select' : `back_to_topping_${index - 1}`;
  const backBtn = new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger);
  row.addComponents(backBtn);
  await interaction.update({ content: `🧂 Topping: **${topping}**. Choose portion:`, components: [row] });
}

async function showPremiumSelect(interaction: any, state: any) {
  const row = makeSelect('premium_select', 'Choose Premium Topping(s)', [
    { label: '🥑 Guacamole', value: 'Guacamole' },
    { label: '🫕 Queso', value: 'Queso' },
    { label: '❌ None', value: 'None' },
  ], { min: 1, max: 3 });
  const backId = state.currentOrder.selectedToppings.length === 0 ? 'back_to_toppings_select' : `back_to_topping_${state.currentOrder.selectedToppings.length - 1}`;
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger)
  );
  await interaction.update({ content: '⭐ Add a premium topping (optional):', components: [row, backRow] });
}

async function showReview(interaction: any, state: any) {
  const config = await getGuildConfig(interaction.guildId || state.guildId) || {};
  const basePrice = config.basePrice || 5.00;
  const bulkPrice = config.bulkPrice;
  const bulkThreshold = config.bulkThreshold;

  const numEntrees = state.orders.length;
  const currentBasePrice = (bulkPrice && bulkThreshold && numEntrees >= bulkThreshold) ? bulkPrice : basePrice;

  const embed = createEmbed(config)
    .setTitle('🛒 Your Order Summary')
    .setDescription(`You have **${numEntrees}** item(s) in your cart. Review your selection below before proceeding to checkout.`);

  let grandTotal = 0;

  state.orders.forEach((order: any, i: number) => {
    let itemPrice = currentBasePrice;

    const proteinStr = order.isDouble ? `Double ${order.proteins[0]}` : order.proteins[0] || 'Veggie';
    
    let optionsStr = `**Protein:** ${proteinStr}\n`;
    optionsStr += `**Rice:** ${order.rice.portion && order.rice.portion !== 'Regular' ? `${order.rice.portion} ` : ''}${order.rice.type}\n`;
    optionsStr += `**Beans:** ${order.beans.portion && order.beans.portion !== 'Regular' ? `${order.beans.portion} ` : ''}${order.beans.type}\n`;
    
    if (order.toppings && order.toppings.length > 0) {
      const toppingsList = order.toppings.map((t: any) => t.portion === 'Regular' ? `${t.type}` : `${t.portion} ${t.type}`).join('\n');
      optionsStr += `**Toppings:**\n${toppingsList}\n`;
    }

    if (order.premiums && order.premiums.length > 0) {
      optionsStr += `**Premium:** ${order.premiums.join(', ')}\n`;
    }

    if (order.isDouble) {
      optionsStr += `*(Double Protein)*\n`;
    }

    optionsStr += `**Item Total: $${itemPrice.toFixed(2)}**`;
    grandTotal += itemPrice;

    const fieldTitle = order.entreeName
      ? `${i + 1}. ${order.type} — ${order.entreeName}`
      : `${i + 1}. ${order.type}`;
    embed.addFields({
      name: fieldTitle,
      value: optionsStr
    });
  });

  embed.addFields({
    name: '━━━━━━━━━━━━━━━━━━━━━━━━',
    value: `### **Total Amount: $${grandTotal.toFixed(2)}**`
  });

  const maxEntrees: number = Math.min(state.maxEntrees || 8, 8);
  const atMax = state.orders.length >= maxEntrees;
  const remaining = maxEntrees - state.orders.length;
  const addLabel = atMax ? null : (remaining === 1 ? '➕ Add Last Item' : `➕ Add Item (${state.orders.length}/${maxEntrees})`);
  const addBtn = addLabel
    ? new ButtonBuilder().setCustomId('add_more').setLabel(addLabel).setStyle(ButtonStyle.Secondary)
    : null;
  const editBtn = new ButtonBuilder().setCustomId('edit_order_start').setLabel('✏️ Edit Order').setStyle(ButtonStyle.Primary);
  const removeBtn = new ButtonBuilder().setCustomId('remove_item_start').setLabel('🗑️ Remove Item').setStyle(ButtonStyle.Danger);
  const checkoutBtn = state.isManual
    ? new ButtonBuilder().setCustomId('confirm_manual').setLabel('✅ Confirm & Print').setStyle(ButtonStyle.Success)
    : new ButtonBuilder().setCustomId('checkout').setLabel('💳 Proceed to Checkout').setStyle(ButtonStyle.Success);
  const backBtn = new ButtonBuilder().setCustomId('back_to_premium').setLabel('Back').setStyle(ButtonStyle.Secondary);

  const rowBtns = [editBtn, removeBtn, checkoutBtn, backBtn];
  if (addBtn) rowBtns.unshift(addBtn);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(rowBtns);

  const components: any[] = [row];
  // Show "Repeat Order" button when there are items and repeating won't exceed 9
  if (state.orders.length > 0 && state.orders.length * 2 <= 9) {
    const repeatBtn = new ButtonBuilder()
      .setCustomId('repeat_order_start')
      .setLabel('🔄 Repeat Order')
      .setStyle(ButtonStyle.Secondary);
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(repeatBtn));
  }

  const method = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  await interaction[method]({ content: '', embeds: [embed], components });
}

async function showEditSelect(interaction: any, state: any) {
  if (state.orders.length === 0) {
    return await interaction.reply({ content: '❌ Your cart is empty.', flags: MessageFlags.Ephemeral });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('edit_item_select')
    .setPlaceholder('Select an item to edit')
    .addOptions(
      state.orders.map((order: any, i: number) => ({
        label: `${i + 1}. ${order.type}`,
        description: order.proteins[0] || 'Veggie',
        value: i.toString()
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backBtn = new ButtonBuilder().setCustomId('back_to_review').setLabel('Back to Review').setStyle(ButtonStyle.Danger);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

  await interaction.update({ content: '✏️ Which item would you like to edit?', components: [row, backRow], embeds: [] });
}

async function showRemoveSelect(interaction: any, state: any) {
  if (state.orders.length === 0) {
    return await interaction.reply({ content: '❌ Your cart is empty.', flags: MessageFlags.Ephemeral });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('remove_item_select')
    .setPlaceholder('Select an item to remove')
    .addOptions(
      state.orders.map((order: any, i: number) => ({
        label: `${i + 1}. ${order.type}`,
        description: order.proteins[0] || 'Veggie',
        value: i.toString()
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backBtn = new ButtonBuilder().setCustomId('back_to_review').setLabel('Back to Review').setStyle(ButtonStyle.Secondary);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

  await interaction.update({ content: '🗑️ Which item would you like to remove?', components: [row, backRow], embeds: [] });
}

async function showAdminBatch(interaction: any) {
  const ordersQuery = db.collection('orders').where('batchStatus', '==', 'pending').where('guildId', '==', interaction.guildId);
  const ordersSnapshot = await ordersQuery.get();
  const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  if (orders.length === 0) {
    return await interaction.reply({ content: 'No orders in the current batch.', flags: MessageFlags.Ephemeral });
  }

  const config = await getGuildConfig(interaction.guildId) || {};
  let batchDetails = '';
  orders.forEach((order: any) => {
    const parsedOrders = safeParseOrders(order.orderData);
    const parsedUserInfo = safeParseUserInfo(order.userInfo);

    const orderText = `**Order ID:** ${order.id.slice(0, 8)}\n${formatConfirmedOrderPayload(order.userId, parsedUserInfo, parsedOrders, config)}\n\n`;
    if (batchDetails.length + orderText.length < 4000) {
      batchDetails += orderText;
    } else if (!batchDetails.endsWith('...')) {
      batchDetails += '... (some orders omitted due to length limit)';
    }
  });
  const embed = createEmbed(config)
    .setTitle(`📦 Current Order Batch (${orders.length} Orders)`)
    .setDescription(batchDetails);

  const clearBtn = new ButtonBuilder()
    .setCustomId('admin_clear_batch')
    .setLabel('🗑️ Clear Batch')
    .setStyle(ButtonStyle.Danger);
    
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(clearBtn);

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else {
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  }
}

async function handleReorder(interaction: any) {
  const ordersQuery = db.collection('orders').where('userId', '==', interaction.user.id).where('guildId', '==', interaction.guildId).orderBy('createdAt', 'desc').limit(1);
  const ordersSnapshot = await ordersQuery.get();
  
  if (ordersSnapshot.empty) {
    return await interaction.reply({ content: '❌ You have no previous orders to reorder.', flags: MessageFlags.Ephemeral });
  }
  
  const lastOrder = ordersSnapshot.docs[0].data();
  const parsedOrders = safeParseOrders(lastOrder.orderData);
  const parsedUserInfo = safeParseUserInfo(lastOrder.userInfo);
  
  const reorderKey = `${interaction.user.id}:${interaction.guildId}`;
  orderState.set(reorderKey, {
    guildId: interaction.guildId,
    orders: parsedOrders,
    info: { ...parsedUserInfo, time: '' },
    currentOrder: { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] },
    pendingReview: true,
    lastUpdated: Date.now()
  });

  const reorderState = orderState.get(reorderKey);
  if (interaction.replied || interaction.deferred) {
    await showPickupTimeSelect(interaction, reorderState);
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await showPickupTimeSelect(interaction, reorderState);
  }
}

async function handleMyOrders(interaction: any) {
  const ordersQuery = db.collection('orders').where('userId', '==', interaction.user.id).where('guildId', '==', interaction.guildId).orderBy('createdAt', 'desc').limit(5);
  const ordersSnapshot = await ordersQuery.get();

  if (ordersSnapshot.empty) {
    return await interaction.reply({ content: '❌ You have no recent orders.', flags: MessageFlags.Ephemeral });
  }

  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle('📦 Your Recent Orders');
    
  ordersSnapshot.docs.forEach((doc, i) => {
    const order = doc.data();
    let status = '🕐 Pending';
    if (order.status === 'paid_fulfilled') status = '🎉 Fulfilled';
    else if (order.status === 'paid') status = '🍳 Paid (Preparing)';
    else if (order.status === 'pending_cashapp') status = '💸 Pending Cash App';
    else if (order.status === 'pending_paypal') status = '🅿️ Pending PayPal';
    else if (order.status === 'pending_venmo') status = '🔵 Pending Venmo';
    else if (order.status === 'pending_zelle') status = '🟣 Pending Zelle';
    else if (order.status === 'pending_crypto') status = '🪙 Pending Crypto';
    
    const parsedOrders = safeParseOrders(order.orderData);
    const itemsOrdered = parsedOrders.map((o: any) => o.type).join(', ') || 'No items';
    const totalCost = order.totalPrice ? `$${order.totalPrice.toFixed(2)}` : 'N/A';
    
    embed.addFields({ 
      name: `Order ${doc.id.slice(0, 8)}`, 
      value: `**Status:** ${status}\n**Date:** ${order.createdAt?.toDate().toLocaleString() || 'Unknown'}\n**Items:** ${itemsOrdered}\n**Total:** ${totalCost}` 
    });
  });
  
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleDeposit(interaction: any) {
  const amount: number = interaction.options.getNumber('amount');
  if (!amount || amount <= 0) {
    return await interaction.reply({ content: '❌ Please provide a valid deposit amount.', flags: MessageFlags.Ephemeral });
  }

  const config = await getGuildConfig(interaction.guildId!) || {};
  const methods: { id: string; label: string; configured: boolean }[] = [
    { id: 'deposit_pay_cashapp', label: '💸 Cash App',  configured: !!config.cashappTag },
    { id: 'deposit_pay_venmo',   label: '💸 Venmo',     configured: !!config.venmoHandle },
    { id: 'deposit_pay_zelle',   label: '💸 Zelle',     configured: !!config.zelleEmail },
    { id: 'deposit_pay_paypal',  label: '🅿️ PayPal',    configured: !!config.paypalEmail },
  ];

  const available = methods.filter(m => m.configured);
  if (!available.length) {
    return await interaction.reply({ content: '❌ No payment methods are configured on this server yet. Ask an admin to run `/setup main`.', flags: MessageFlags.Ephemeral });
  }

  // Generate deposit ID and store in user session state
  const depositId = generateShortOrderId().slice(0, 6); // 3 letters + 3 numbers
  const stateKey = `${interaction.user.id}:${interaction.guildId}`;
  const state = orderState.get(stateKey) || {};
  state.pendingDepositId = depositId;
  state.pendingDepositAmount = amount;
  state.pendingDepositMethod = null;
  orderState.set(stateKey, state);

  const buttons = available.map(m =>
    new ButtonBuilder().setCustomId(m.id).setLabel(m.label).setStyle(ButtonStyle.Primary)
  );

  const embed = createEmbed(config)
    .setTitle('💳 Deposit Funds to Wallet')
    .setDescription(`You are depositing **$${amount.toFixed(2)}** to your wallet.\n\nSelect your preferred payment method below.\nYour wallet will be credited automatically once payment is verified.`);

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5))],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWallet(interaction: any) {
  const customerDoc = await db.collection('guilds').doc(interaction.guildId).collection('customers').doc(interaction.user.id).get();
  const balance: number = customerDoc.exists ? (customerDoc.data()?.creditBalance || 0) : 0;
  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle('💳 Your Store Credit')
    .setDescription(`You have **$${balance.toFixed(2)}** in store credit.\n\nCredit is applied automatically at checkout.`);
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleSupport(interaction: any) {
  await interaction.reply({ content: '🛠️ **Need Help?**\n\nPlease open a ticket in the designated support channel or contact an administrator.', flags: MessageFlags.Ephemeral });
}

// Returns the round number (1-4) currently active for ordering, or null if no round is open
function getActiveRoundNumber(): number | null {
  const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const totalMinutes = nowPST.getHours() * 60 + nowPST.getMinutes();
  const rounds = [
    { num: 1, queueOpen: 6*60+45,  placement: 8*60+45  },
    { num: 2, queueOpen: 9*60+45,  placement: 11*60+45 },
    { num: 3, queueOpen: 12*60+45, placement: 14*60+45 },
    { num: 4, queueOpen: 14*60+45, placement: 16*60+45 },
  ];
  for (const round of rounds) {
    if (totalMinutes >= round.queueOpen && totalMinutes < round.placement) return round.num;
  }
  return null;
}

async function handleHours(interaction: any) {
  const config = await getGuildConfig(interaction.guildId!) || {};
  const pausedRounds: number[] = config.pausedRounds || [];

  const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const totalMinutes = nowPST.getHours() * 60 + nowPST.getMinutes();

  const rounds = [
    { num: 1, label: 'Round 1', icon: '🌙', queueOpen: 6*60+45,  placement: 8*60+45,  pickupStart: 9*60+30,  pstLabel: '8:45 AM PST / 11:45 AM EST' },
    { num: 2, label: 'Round 2', icon: '☀️', queueOpen: 9*60+45,  placement: 11*60+45, pickupStart: 12*60+30, pstLabel: '11:45 AM PST / 2:45 PM EST'  },
    { num: 3, label: 'Round 3', icon: '🌆', queueOpen: 12*60+45, placement: 14*60+45, pickupStart: 15*60+30, pstLabel: '2:45 PM PST / 5:45 PM EST'   },
    { num: 4, label: 'Round 4', icon: '🌇', queueOpen: 14*60+45, placement: 16*60+45, pickupStart: 17*60+30, pstLabel: '4:45 PM PST / 7:45 PM EST'   },
  ];

  function fmtTime(m: number): string {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${min.toString().padStart(2, '0')} ${period} PST`;
  }

  let description = '';
  for (const r of rounds) {
    const isPaused = pausedRounds.includes(r.num);
    const isOpen = !isPaused && totalMinutes >= r.queueOpen && totalMinutes < r.placement;
    const isUpcoming = !isPaused && totalMinutes < r.queueOpen;
    const isPast = totalMinutes >= r.placement;

    let statusBadge: string;
    if (isPaused) statusBadge = '⏸️ **PAUSED**';
    else if (isOpen) statusBadge = '🟢 **OPEN**';
    else if (isUpcoming) statusBadge = `🕐 Opens at ${fmtTime(r.queueOpen)}`;
    else statusBadge = '🔴 Closed';

    description += `${r.icon} **${r.label}** — Placement: ${r.pstLabel}\n`;
    description += `> Status: ${statusBadge}\n`;
    if (!isPast && !isPaused) {
      description += `> Queue opens: ${fmtTime(r.queueOpen)} | Earliest pickup: ${fmtTime(r.pickupStart)}\n`;
    }
    description += '\n';
  }

  const storeStatus = config.storeOpen === false ? '\n🔴 **Store is currently CLOSED** — no orders accepted.' : '\n🟢 **Store is OPEN**';
  const embed = createEmbed(config)
    .setTitle('🕐 Today\'s Queue Hours')
    .setDescription(description.trim() + storeStatus);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCredit(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const targetUser = interaction.options.getUser('user');
  const amount: number = interaction.options.getNumber('amount');
  const reason: string = interaction.options.getString('reason') || 'Admin adjustment';

  const customerRef = db.collection('guilds').doc(interaction.guildId!).collection('customers').doc(targetUser.id);
  const customerDoc = await customerRef.get();
  const currentBalance: number = customerDoc.exists ? (customerDoc.data()?.creditBalance || 0) : 0;
  const newBalance = Math.max(0, currentBalance + amount);

  await customerRef.set({
    userId: targetUser.id,
    creditBalance: newBalance,
    lastCreditAdjustment: serverTimestamp(),
    lastCreditReason: reason,
  }, { merge: true });

  const config = await getGuildConfig(interaction.guildId!) || {};
  const sign = amount >= 0 ? '+' : '';
  const embed = createEmbed(config)
    .setTitle('💳 Credit Adjusted')
    .addFields(
      { name: 'Customer', value: `<@${targetUser.id}>`, inline: true },
      { name: 'Change', value: `${sign}$${amount.toFixed(2)}`, inline: true },
      { name: 'New Balance', value: `$${newBalance.toFixed(2)}`, inline: true },
      { name: 'Reason', value: reason },
    );

  await interaction.editReply({ embeds: [embed] });

  // Notify the customer
  try {
    const dm = await targetUser.createDM();
    const dmMsg = amount >= 0
      ? `💳 **${interaction.guild?.name}**: You've received **+$${amount.toFixed(2)}** in store credit (${reason}). New balance: **$${newBalance.toFixed(2)}**.`
      : `💳 **${interaction.guild?.name}**: **$${Math.abs(amount).toFixed(2)}** was deducted from your store credit (${reason}). New balance: **$${newBalance.toFixed(2)}**.`;
    await dm.send(dmMsg);
  } catch (e) {
    console.warn('Could not DM user for credit notification:', e);
  }
}

async function handlePause(interaction: any) {
  const roundArg = interaction.options.getString('round');
  const action = interaction.options.getString('action'); // 'pause' | 'resume'

  const config = await getGuildConfig(interaction.guildId!) || {};
  let pausedRounds: number[] = config.pausedRounds || [];

  const affectedRounds = roundArg === 'all' ? [1, 2, 3, 4] : [parseInt(roundArg, 10)];

  if (action === 'pause') {
    for (const r of affectedRounds) {
      if (!pausedRounds.includes(r)) pausedRounds.push(r);
    }
  } else {
    pausedRounds = pausedRounds.filter(r => !affectedRounds.includes(r));
  }

  await updateGuildConfig(interaction.guildId!, { pausedRounds });

  const roundLabel = roundArg === 'all' ? 'All Rounds' : `Round ${roundArg}`;
  const actionLabel = action === 'pause' ? '⏸️ paused' : '▶️ resumed';
  await interaction.reply({
    content: `${actionLabel === '⏸️ paused' ? '⏸️' : '▶️'} **${roundLabel}** has been **${action === 'pause' ? 'paused' : 'resumed'}**. Customers will ${action === 'pause' ? 'not be able to order during this round.' : 'be able to order normally.'}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDm(interaction: any) {
  const targetUser = interaction.options.getUser('user');
  const message = interaction.options.getString('message');

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dm = await targetUser.createDM();
    await dm.send(`📬 **Message from ${interaction.guild?.name}:**\n\n${message}`);
    await interaction.editReply({ content: `✅ Message delivered to <@${targetUser.id}>.` });
  } catch (e) {
    console.error('handleDm error:', e);
    await interaction.editReply({ content: `❌ Could not send DM to <@${targetUser.id}>. They may have DMs disabled.` });
  }
}

async function handleStats(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const startOfDay = new Date(nowPST.getFullYear(), nowPST.getMonth(), nowPST.getDate(), 0, 0, 0);

  const ordersQuery = db.collection('orders')
    .where('guildId', '==', interaction.guildId)
    .where('createdAt', '>=', startOfDay);
  const snapshot = await ordersQuery.get();

  let orderCount = 0;
  let totalRevenue = 0;
  let totalEntrees = 0;
  const itemCounts = new Map<string, number>();

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    orderCount++;
    if (data.totalPrice) totalRevenue += data.totalPrice;
    const items = safeParseOrders(data.orderData);
    totalEntrees += items.length;
    items.forEach((item: any) => {
      if (item.type) itemCounts.set(item.type, (itemCounts.get(item.type) || 0) + 1);
    });
  });

  const avgOrderSize = orderCount > 0 ? totalEntrees / orderCount : 0;
  const topItems = Array.from(itemCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const config = await getGuildConfig(interaction.guildId!) || {};
  const embed = createEmbed(config)
    .setTitle(`📊 Today's Stats — ${nowPST.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' })}`)
    .addFields(
      { name: '📦 Orders Today', value: `${orderCount}`, inline: true },
      { name: '💰 Revenue Today', value: `$${totalRevenue.toFixed(2)}`, inline: true },
      { name: '🌯 Avg Items/Order', value: orderCount > 0 ? avgOrderSize.toFixed(1) : 'N/A', inline: true },
    );

  if (topItems.length > 0) {
    const topStr = topItems.map(([name, count], i) => `**${i + 1}.** ${name} — ${count}`).join('\n');
    embed.addFields({ name: '🏆 Top Items', value: topStr });
  } else {
    embed.addFields({ name: '🏆 Top Items', value: 'No orders yet today.' });
  }

  await interaction.editReply({ embeds: [embed] });
}

const FOODIE_TEMPLATE = `Order 1:
John Doe
john@gmail.com
2940 Cropsey Ave
Brooklyn, NY 11214
Burrito Bowl
Double Chicken
White Rice
Black Beans
Fresh Tomato Salsa
(Extra) Sour Cream
Cheese
Guacamole

Order 2:
Jane Smith
jane@gmail.com
123 Main St
Los Angeles, CA 90001
Burrito
Steak
Brown Rice
Pinto Beans
(Extra) Tomatillo-Green Chili Salsa
Fajita Veggies
Cheese
(Extra) Lettuce
Queso
`;

// ── Foodie parser helpers ───────────────────────────────────────────────────
const _ENTREES  = ['burrito bowl', 'bowl', 'burrito', 'tacos', 'taco', 'quesadilla', 'salad', 'kids meal'];
const _PROTEINS = ['chicken al pastor', 'al pastor', 'chicken', 'steak', 'beef barbacoa', 'barbacoa', 'carnitas', 'sofritas', 'veggie'];
const _RICE     = ['white rice', 'brown rice', 'cilantro-lime'];
const _BEANS    = ['black beans', 'pinto beans'];
const _PREMIUM  = ['guacamole', 'guac', 'queso'];
const _SKIP     = ['united states', 'canada', 'mexico', 'united kingdom', 'uk'];

function _portion(line: string): { text: string; portion: string } {
  const m = line.match(/^\(?(Extra|Light)\)?\s+(.+)$/i) || line.match(/^(Extra|Light)\s+(.+)$/i);
  if (m) return { text: m[2].trim(), portion: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() };
  return { text: line.trim(), portion: 'Regular' };
}

function _titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Parses a customer block array into { userInfo, parsedOrder, missing[] }
function _parseFoodieBlock(lines: string[]): any | null {
  if (lines.length === 0) return null;
  const name = lines[0];
  let email = '';
  const addressParts: string[] = [];
  const foodLines: string[] = [];
  let foodStarted = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const norm = line.toLowerCase();
    if (_SKIP.some(s => norm === s)) continue;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line) || /^email:\s*/i.test(line)) {
      email = line.replace(/^email:\s*/i, '').trim(); continue;
    }
    if (!foodStarted) {
      const isStreet  = /^\d+\s+\w/.test(line);
      const isCityZip = /^[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}/.test(line);
      const stripped  = _portion(line).text.toLowerCase();
      const looksLikeFood =
        _ENTREES.some(p => stripped === p || stripped.startsWith(p))  ||
        _PROTEINS.some(p => stripped === p || stripped.endsWith(p))   ||
        /^double\s+/i.test(line)                                       ||
        _RICE.some(p => stripped.includes(p))                         ||
        _BEANS.some(p => stripped.includes(p))                        ||
        _PREMIUM.some(p => stripped === p || stripped.startsWith(p));
      if (isStreet || isCityZip) addressParts.push(line);
      else if (looksLikeFood) { foodStarted = true; foodLines.push(line); }
      else addressParts.push(line);
    } else {
      foodLines.push(line);
    }
  }

  let entreeType = '', proteinName = '', isDouble = false;
  let riceType = 'None', ricePortion = 'Regular';
  let beansType = 'None', beansPortion = 'Regular';
  const toppings: { type: string; portion: string }[] = [];
  const premiums: string[] = [];
  let foundEntree = false, foundProtein = false, foundRice = false, foundBeans = false;

  for (const line of foodLines) {
    const { text, portion } = _portion(line);
    const norm = text.toLowerCase();
    if (!foundEntree && _ENTREES.some(p => norm === p || norm.startsWith(p))) {
      entreeType = _titleCase(text); foundEntree = true;
    } else if (!foundProtein && (/^double\s+/i.test(line) || _PROTEINS.some(p => norm === p || norm.endsWith(p)))) {
      const dm = line.match(/^double\s+(.+)$/i);
      isDouble = !!dm;
      proteinName = dm ? dm[1].replace(/^\(?(extra|light)\)?\s+/i, '').trim() : text;
      proteinName = _titleCase(proteinName);
      foundProtein = true;
    } else if (!foundRice && _RICE.some(p => norm.includes(p))) {
      riceType = _titleCase(text); ricePortion = portion; foundRice = true;
    } else if (!foundBeans && _BEANS.some(p => norm.includes(p))) {
      beansType = _titleCase(text); beansPortion = portion; foundBeans = true;
    } else if (_PREMIUM.some(p => norm === p || norm.startsWith(p))) {
      premiums.push(_titleCase(text));
    } else {
      toppings.push({ type: _titleCase(text), portion });
    }
  }

  const missing: string[] = [];
  if (!addressParts.length) missing.push('location');
  missing.push('time');   // never extractable from free-form file
  missing.push('phone');  // never extractable from free-form file
  if (!email)               missing.push('email');
  if (!foundEntree)         missing.push('entree');
  if (!foundProtein)        missing.push('protein');
  if (!foundRice)           missing.push('rice');
  if (!foundBeans)          missing.push('beans');
  if (!toppings.length && premiums.length === 0) missing.push('toppings');

  return {
    userInfo: { name, location: addressParts.join(', '), time: '', phone: '', email },
    parsedOrder: {
      type: entreeType || '',
      proteins: [proteinName || ''],
      isDouble,
      rice: { type: riceType, portion: ricePortion },
      beans: { type: beansType, portion: beansPortion },
      toppings,
      premiums,
    },
    missing,
  };
}

function parseFoodieFile(text: string): { customers: any[]; skipped: number } {
  const rawLines = text.split(/\r?\n/);
  const orderStarts: number[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (/^Order\s+\d+\s*:?\s*$/i.test(rawLines[i].trim())) orderStarts.push(i);
  }
  if (orderStarts.length === 0) return { customers: [], skipped: 0 };

  const blocks: string[][] = orderStarts.map((start, idx) => {
    const end = idx + 1 < orderStarts.length ? orderStarts[idx + 1] : rawLines.length;
    return rawLines.slice(start + 1, end).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  });

  const customers: any[] = [];
  let skipped = 0;
  for (const lines of blocks) {
    const parsed = _parseFoodieBlock(lines);
    if (!parsed) { skipped++; continue; }
    customers.push(parsed);
  }
  return { customers, skipped };
}

// Build the missing-info form in the exact format the user specified
function buildFoodieForm(customers: any[]): string {
  const location = customers.find(c => c.userInfo.location)?.userInfo.location || '';
  const email    = customers.find(c => c.userInfo.email)?.userInfo.email || '';

  let form = '';
  form += `Pickup Location(s)? ${location}\n`;
  form += `Pickup Time? - Enter your Restaurant Timezone \n`;
  form += `Phone #? \n`;
  form += `Email? ${email}\n`;

  customers.forEach((c, i) => {
    const o = c.parsedOrder;
    const u = c.userInfo;
    form += `\nOrder ${i + 1}\n`;
    form += `Name on Order ${u.name || ''}\n`;
    form += `Bowl or Burrito ${o.type || ''}\n`;
    form += `Protein ${o.isDouble ? 'Double ' : ''}${o.proteins[0] || ''}\n`;
    form += `Rice ${o.rice.type !== 'None' ? (o.rice.portion !== 'Regular' ? o.rice.portion + ' ' : '') + o.rice.type : ''}\n`;
    form += `Beans ${o.beans.type !== 'None' ? (o.beans.portion !== 'Regular' ? o.beans.portion + ' ' : '') + o.beans.type : ''}\n`;
    form += `Toppings\n`;
    for (const t of o.toppings) {
      form += `${t.portion !== 'Regular' ? t.portion + ' ' : ''}${t.type}\n`;
    }
    if (o.premiums && o.premiums.length > 0) for (const p of o.premiums) form += `${p}\n`;
  });

  return form.trim();
}

// Parse user's filled-in form and merge with stored customers
function mergeFoodieFormResponse(formText: string, customers: any[]): any[] {
  const lines = formText.split('\n').map(l => l.trim()).filter(Boolean);

  // Helper: get value after a label (label may end with ?)
  const getAfterLabel = (label: string): string => {
    const line = lines.find(l => l.toLowerCase().startsWith(label.toLowerCase()));
    if (!line) return '';
    return line.slice(label.length).trim();
  };

  // Global fields (with ? suffix in labels)
  const globalLocation = getAfterLabel('Pickup Location(s)?');
  const rawTime        = getAfterLabel('Pickup Time?');
  const globalTime     = rawTime.replace(/^-?\s*Enter your Restaurant Timezone\s*/i, '').trim();
  const globalPhone    = getAfterLabel('Phone #?');
  const globalEmail    = getAfterLabel('Email?');

  // Per-order sections — toppings are multi-line (one per line after "Toppings" label)
  const orderSections: Map<number, Record<string, any>> = new Map();
  let currentIdx = -1;
  let inToppings = false;

  for (const line of lines) {
    const orderMatch = line.match(/^Order\s+(\d+)\s*$/i);
    if (orderMatch) {
      currentIdx = parseInt(orderMatch[1], 10) - 1;
      orderSections.set(currentIdx, { toppingLines: [] });
      inToppings = false;
      continue;
    }
    if (currentIdx < 0) continue;
    const section = orderSections.get(currentIdx)!;

    if (inToppings) {
      section.toppingLines.push(line);
      continue;
    }

    if (line.toLowerCase().startsWith('toppings')) {
      inToppings = true;
      const remainder = line.slice('toppings'.length).trim();
      if (remainder) section.toppingLines.push(remainder);
      continue;
    }

    const fieldMap: [string, string][] = [
      ['name on order',  'name'],
      ['bowl or burrito', 'entree'],
      ['protein',         'protein'],
      ['rice',            'rice'],
      ['beans',           'beans'],
    ];
    for (const [label, key] of fieldMap) {
      if (line.toLowerCase().startsWith(label)) {
        section[key] = line.slice(label.length).trim();
        break;
      }
    }
  }

  return customers.map((c, i) => {
    const section = orderSections.get(i) || { toppingLines: [] };
    const userInfo = { ...c.userInfo };
    if (globalLocation) userInfo.location = globalLocation;
    if (globalTime)     userInfo.time     = globalTime;
    if (globalPhone)    userInfo.phone    = globalPhone;
    if (globalEmail)    userInfo.email    = globalEmail;
    if (section['name']) userInfo.name    = section['name'];

    const parsedOrder = { ...c.parsedOrder, toppings: [...c.parsedOrder.toppings] };

    if (section['entree'])  parsedOrder.type = section['entree'];
    if (section['protein']) {
      const dm = section['protein'].match(/^double\s+(.+)$/i);
      parsedOrder.isDouble = !!dm;
      parsedOrder.proteins = [dm ? dm[1].trim() : section['protein']];
    }
    if (section['rice'])  parsedOrder.rice  = { type: section['rice'],  portion: 'Regular' };
    if (section['beans']) parsedOrder.beans = { type: section['beans'], portion: 'Regular' };

    const toppingLines: string[] = section.toppingLines || [];
    if (toppingLines.length > 0) {
      const premiumNames = ['guacamole', 'guac', 'queso'];
      const premiumIdx = toppingLines.findIndex(t => premiumNames.some(p => t.toLowerCase().startsWith(p)));
      const toppingItems = premiumIdx >= 0 ? toppingLines.slice(0, premiumIdx) : toppingLines;
      const premiumItem  = premiumIdx >= 0 ? toppingLines[premiumIdx] : parsedOrder.premium;
      parsedOrder.toppings = toppingItems.map(t => {
        const pm = t.match(/^\(?(Extra|Light)\)?\s+(.+)$/i) || t.match(/^(Extra|Light)\s+(.+)$/i);
        return pm ? { type: pm[2], portion: pm[1][0].toUpperCase() + pm[1].slice(1).toLowerCase() } : { type: t, portion: 'Regular' };
      });
      parsedOrder.premium = premiumItem || 'None';
    }

    return { userInfo, parsedOrder };
  });
}

// Format customers into the exact clean output format
function formatFoodieCustomers(customers: any[], _config: any): string {
  const blocks: string[] = [];

  customers.forEach((c, i) => {
    const { userInfo: u, parsedOrder: o } = c;
    let block = '';
    block += `Pickup Location: ${u.location || ''}\n`;
    block += `Pickup Time: ${u.time || ''}\n`;
    block += `Phone: ${u.phone || ''}\n`;
    block += `Email: ${u.email || ''}\n`;
    block += '\n';
    block += `Order ${i + 1}\n`;
    block += `${u.name || ''}\n`;
    block += `${o.type || ''}\n`;
    block += `${o.isDouble ? 'Double ' : ''}${o.proteins[0] || ''}\n`;
    // Rice
    if (o.rice.type && o.rice.type !== 'None') {
      block += `${o.rice.portion !== 'Regular' ? o.rice.portion + ' ' : ''}${o.rice.type}\n`;
    }
    // Beans
    if (o.beans.type && o.beans.type !== 'None') {
      block += `${o.beans.portion !== 'Regular' ? o.beans.portion + ' ' : ''}${o.beans.type}\n`;
    }
    // Toppings (one per line)
    for (const t of o.toppings) {
      block += `${t.portion !== 'Regular' ? t.portion + ' ' : ''}${t.type}\n`;
    }
    // Premium
    if (o.premiums && o.premiums.length > 0) {
      for (const p of o.premiums) block += `${p}\n`;
    }

    blocks.push(block.trim());
  });

  return blocks.join('\n\n' + '─'.repeat(40) + '\n\n');
}

async function handleManualOrder(interaction: any) {
  const modal = new ModalBuilder()
    .setCustomId('manual_info_modal')
    .setTitle('Manual Order — Customer Info');
  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
      new TextInputBuilder().setCustomId('manual_name').setLabel('Name on Order').setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
      new TextInputBuilder().setCustomId('manual_zipcode').setLabel('Zip Code (to find nearby Chipotle)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 90210').setRequired(true)
    ),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
      new TextInputBuilder().setCustomId('manual_phone').setLabel('Phone Number').setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
      new TextInputBuilder().setCustomId('manual_email').setLabel('Email').setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
      new TextInputBuilder().setCustomId('manual_entrees').setLabel('Number of Entrees (1–9)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 2').setRequired(true)
    ),
  );
  await interaction.showModal(modal);
}

// Returns the PST queue-open / placement time window for a round (today)
function getRoundTimeRange(roundNum: number): { start: Date; end: Date } | null {
  const schedule: Record<number, { open: number; close: number }> = {
    1: { open: 6*60+45,  close: 8*60+45  },
    2: { open: 9*60+45,  close: 11*60+45 },
    3: { open: 12*60+45, close: 14*60+45 },
    4: { open: 14*60+45, close: 16*60+45 },
  };
  const r = schedule[roundNum];
  if (!r) return null;
  const nowPST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const base = new Date(nowPST.getFullYear(), nowPST.getMonth(), nowPST.getDate());
  const start = new Date(base); start.setHours(Math.floor(r.open / 60),  r.open  % 60, 0,  0);
  const end   = new Date(base); end.setHours(Math.floor(r.close / 60), r.close % 60, 59, 999);
  return { start, end };
}

async function handleRoundSummary(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const roundNum = interaction.options.getInteger('round');
  const range = getRoundTimeRange(roundNum);
  if (!range) return await interaction.editReply({ content: '❌ Invalid round number.' });

  const snapshot = await db.collection('orders')
    .where('guildId', '==', interaction.guildId)
    .where('createdAt', '>=', range.start)
    .where('createdAt', '<=', range.end)
    .orderBy('createdAt', 'asc')
    .get();

  if (snapshot.empty) {
    return await interaction.editReply({ content: `📋 No orders found for Round ${roundNum} today.` });
  }

  const config = await getGuildConfig(interaction.guildId!) || {};
  let revenue = 0, entreeCount = 0;
  const lines: string[] = [];

  const statusIcon: Record<string, string> = {
    paid_fulfilled: '✅', paid: '💳', pending: '⏳',
    pending_venmo: '💸', pending_cashapp: '💸', pending_zelle: '💸', pending_paypal: '🅿️',
    pending_crypto: '🔑', cancelled: '❌',
  };

  for (const doc of snapshot.docs) {
    const data = doc.data();
    revenue += data.totalPrice || 0;
    const items = safeParseOrders(data.orderData);
    const info  = safeParseUserInfo(data.userInfo);
    entreeCount += items.length;
    const itemStr = items.map((o: any) =>
      `${o.type}${o.proteins?.length ? ` (${o.proteins.join(', ')})` : ''}`
    ).join(', ');
    const icon = statusIcon[data.status] || '❓';
    lines.push(`${icon} **${info.name || 'Unknown'}** — ${itemStr} — $${(data.totalPrice || 0).toFixed(2)}`);
  }

  const embed = createEmbed(config)
    .setTitle(`📋 Round ${roundNum} Summary — Today`)
    .addFields(
      { name: '📦 Orders',  value: String(snapshot.size), inline: true },
      { name: '💰 Revenue', value: `$${revenue.toFixed(2)}`,  inline: true },
      { name: '🌯 Entrees', value: String(entreeCount),        inline: true },
    );

  // Split order list into ≤1024-char chunks (Discord embed field limit)
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? cur + '\n' + line : line;
    if (next.length > 1024) { chunks.push(cur); cur = line; }
    else cur = next;
  }
  if (cur) chunks.push(cur);
  chunks.forEach((chunk, i) =>
    embed.addFields({ name: i === 0 ? 'Orders' : '\u200B', value: chunk })
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleExportRound(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const roundNum = interaction.options.getInteger('round');
  const range = getRoundTimeRange(roundNum);
  if (!range) return await interaction.editReply({ content: '❌ Invalid round number.' });

  const snapshot = await db.collection('orders')
    .where('guildId', '==', interaction.guildId)
    .where('createdAt', '>=', range.start)
    .where('createdAt', '<=', range.end)
    .orderBy('createdAt', 'asc')
    .get();

  if (snapshot.empty) {
    return await interaction.editReply({ content: `📋 No orders found for Round ${roundNum} today.` });
  }

  let csv = 'Order ID,User ID,Status,Total Price,Created At,Name,Location,Time,Phone,Email,Order Details\n';
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    const items = safeParseOrders(data.orderData);
    const info  = safeParseUserInfo(data.userInfo);
    const orderDetails = items.map((o: any) => `${o.type} (${(o.proteins || []).join(', ')})`).join('; ');
    const dateStr = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : 'N/A';
    const row = [
      doc.id, data.userId || 'N/A', data.status || 'N/A', data.totalPrice || 0,
      dateStr, info.name || 'N/A', info.location || 'N/A', info.time || 'N/A',
      info.phone || 'N/A', info.email || 'N/A', orderDetails,
    ].map(f => `"${String(f).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`).join(',');
    csv += row + '\n';
  });

  const buf  = Buffer.from(csv, 'utf-8');
  const file = new AttachmentBuilder(buf, { name: `round_${roundNum}_export.csv` });
  await interaction.editReply({
    content: `✅ Round ${roundNum} export — **${snapshot.size}** order(s).`,
    files: [file],
  });
}

async function handleFormatOrderFoodie(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const wantsTemplate = interaction.options.getBoolean('template');
  if (wantsTemplate) {
    const buf = Buffer.from(FOODIE_TEMPLATE, 'utf8');
    const file = new AttachmentBuilder(buf, { name: 'order_template.txt' });
    return await interaction.editReply({
      content: '📄 Here is the template. Fill it out and run `/formatorderfoodie file:your_file.txt`.',
      files: [file],
    });
  }

  const attachment = interaction.options.getAttachment('file');
  if (!attachment) {
    return await interaction.editReply({
      content: '❌ Attach a `.txt` file, or use `template:True` to download the template.',
    });
  }
  if (!attachment.name?.endsWith('.txt')) {
    return await interaction.editReply({ content: '❌ Only `.txt` files are supported.' });
  }

  let text: string;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    console.error('formatorderfoodie fetch error:', e);
    return await interaction.editReply({ content: '❌ Could not read the attached file.' });
  }

  const config = await getGuildConfig(interaction.guildId!) || {};
  const { customers, skipped } = parseFoodieFile(text);
  console.log(`[foodie] parsed ${customers.length} customer(s), skipped ${skipped}`);
  customers.forEach((c, i) => console.log(`  [${i}] name="${c.userInfo.name}" location="${c.userInfo.location}" email="${c.userInfo.email}" missing=[${c.missing.join(',')}] entree="${c.parsedOrder.type}" protein="${c.parsedOrder.proteins[0]}"`));

  if (customers.length === 0) {
    return await interaction.editReply({
      content: '❌ No valid orders found. Use `template:True` to see the expected format.',
    });
  }

  const allMissing = customers.flatMap(c => c.missing);
  const hasMissing = allMissing.length > 0;

  if (!hasMissing) {
    // Nothing missing — format and return immediately
    const formatted = formatFoodieCustomers(customers, config);
    const note = skipped > 0 ? ` (${skipped} block(s) skipped)` : '';
    const buf = Buffer.from(formatted, 'utf8');
    const file = new AttachmentBuilder(buf, { name: 'formatted_orders.txt' });
    return await interaction.editReply({
      content: `✅ Formatted **${customers.length}** order(s).${note}`,
      files: [file],
    });
  }

  // Missing fields — build the form and ask the user to fill it in
  const stateKey = `${interaction.user.id}:${interaction.guildId}`;
  pendingFoodieOrders.set(stateKey, { customers, config, createdAt: Date.now() });

  const formText = buildFoodieForm(customers);
  console.log(`[foodie] form text (${formText.length} chars):\n${formText}`);
  const fillBtn = new ButtonBuilder()
    .setCustomId('foodie_fill_missing')
    .setLabel('📝 Fill In Missing Info')
    .setStyle(ButtonStyle.Primary);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(fillBtn);

  const missingList = customers.map((c, i) =>
    c.missing.length ? `Order ${i + 1} (${c.userInfo.name}): ${c.missing.join(', ')}` : null
  ).filter(Boolean).join('\n');

  await interaction.editReply({
    content: `⚠️ **Some information is missing.** Click below to fill it in.\n\`\`\`\n${missingList}\n\`\`\``,
    components: [row],
  });
}

async function handleHelp(interaction: any) {
  const config = await getGuildConfig(interaction.guildId) || {};
  const embed = createEmbed(config)
    .setTitle('🌯 Chipotle Bot — Help')
    .setDescription('Welcome! Here\'s everything you can do:')
    .addFields(
      { name: '🛒 `/order`', value: 'Start a new Chipotle order. Enter your info, pick your store, and build your meal.' },
      { name: '🔁 `/reorder`', value: 'Instantly repeat your last order.' },
      { name: '📦 `/myorders`', value: 'Check the status of your recent orders.' },
      { name: '📋 `/menu`', value: 'View the full Chipotle menu.' },
      { name: '🗓️ `/schedule`', value: 'View queue times, pickup rules, and how ordering works.' },
      { name: '💳 `/wallet`', value: 'Check your current credit balance.' },
      { name: '🕐 `/hours`', value: "View today's queue schedule and which rounds are open, closed, or paused." },
      { name: '🛠️ `/support`', value: 'Get help if you have an issue with your order.' },
      { name: '⏰ Queue Times', value: '🌙 Round 1 — Placement: 8:45 AM PST (pickup from 9:30 AM)\n☀️ Round 2 — Placement: 11:45 AM PST (pickup from 12:30 PM)\n🌆 Round 3 — Placement: 2:45 PM PST (pickup from 3:30 PM)\n🌇 Round 4 — Placement: 4:45 PM PST (pickup from 5:30 PM)\n\n*Queue opens 2 hrs before each placement time.*' }
    );
    
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
