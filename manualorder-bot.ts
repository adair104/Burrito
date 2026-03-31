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
  AttachmentBuilder,
  MessageFlags,
  ModalActionRowComponentBuilder,
} from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const orderState = new Map<string, any>();

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeInput(input: string, maxLength = 200): string {
  return input
    .replace(/@(everyone|here)/gi, '@\u200B$1')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/\n/g, ' ')
    .slice(0, maxLength)
    .trim();
}

function applyReplacements(template: string, map: Record<string, string>): string {
  return Object.entries(map).reduce(
    (s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, 'g'), v),
    template
  );
}

function createEmbed() {
  return new EmbedBuilder()
    .setColor(0xFF6321)
    .setAuthor({ name: 'Manual Order Bot' });
}

function getPSTUtcOffsetMinutes(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date());
  const offsetStr = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
  const match = offsetStr.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) return -480;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (parseInt(match[2], 10) * 60 + (match[3] ? parseInt(match[3], 10) : 0));
}

const STATE_TIMEZONE: Record<string, string> = {
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit',  NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', NC: 'America/New_York',
  OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', VT: 'America/New_York', VA: 'America/New_York',
  WV: 'America/New_York', DC: 'America/New_York',
  IN: 'America/Indiana/Indianapolis', KY: 'America/Kentucky/Louisville',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago',
  IA: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago',
  MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago',
  NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver',   ID: 'America/Boise',
  MT: 'America/Denver',  NM: 'America/Denver',   UT: 'America/Denver',
  WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

function resolveTimezone(stateAbbr: string): string {
  return STATE_TIMEZONE[stateAbbr.toUpperCase()] || 'America/Los_Angeles';
}

function pstTimeToLocalLabel(hourPST: number, minutePST: number, tz: string): string {
  const pstOffset = getPSTUtcOffsetMinutes();
  const pstParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const year  = Number(pstParts.find(p => p.type === 'year')?.value);
  const month = Number(pstParts.find(p => p.type === 'month')?.value) - 1;
  const day   = Number(pstParts.find(p => p.type === 'day')?.value);
  const totalUtc = hourPST * 60 + minutePST - pstOffset;
  const utcDayOff = Math.floor(totalUtc / 1440);
  const utcMin = ((totalUtc % 1440) + 1440) % 1440;
  const utcDate = new Date(Date.UTC(year, month, day + utcDayOff, Math.floor(utcMin / 60), utcMin % 60));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(utcDate);
}

function getStoreClosePSTMinutes(tz: string): number {
  const pstOffset = getPSTUtcOffsetMinutes();
  const tzParts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
  const offsetStr = tzParts.find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
  const match = offsetStr.match(/GMT([+-])(\d+)(?::(\d+))?/);
  const sign = match ? (match[1] === '+' ? 1 : -1) : -1;
  const userOffset = match ? sign * (parseInt(match[2], 10) * 60 + (match[3] ? parseInt(match[3], 10) : 0)) : -480;
  return (22 * 60 + 30) - userOffset + pstOffset;
}

function generatePickupTimeOptions(earliestMinutes: number, tz: string) {
  const storeClose = getStoreClosePSTMinutes(tz);
  const options: { label: string; value: string }[] = [];
  for (let m = earliestMinutes; m <= storeClose; m += 15) {
    const label = pstTimeToLocalLabel(Math.floor(m / 60), m % 60, tz);
    options.push({ label, value: label });
  }
  return options;
}

function formatOrder(userId: string, info: any, orders: any[]): string {
  const header = applyReplacements(
    `Customer: {name}\nPickup Location: {location}\nPickup Time: {time}\nPhone: {phone}\nEmail: {email}`,
    { name: info.name || 'N/A', location: info.location || 'N/A', time: info.time || 'N/A', phone: info.phone || 'N/A', email: info.email || 'N/A' }
  );

  const items = orders.map((order, i) => {
    const protein = order.isDouble ? `Double ${order.proteins[0]}` : order.proteins[0] || 'Veggie';
    const toppings = order.toppings.map((t: any) => t.portion === 'Regular' ? t.type : `${t.portion} ${t.type}`).join('\n') || 'None';
    const rice = order.rice.type === 'None' ? '' : (order.rice.portion && order.rice.portion !== 'Regular' ? `${order.rice.portion} ${order.rice.type}` : order.rice.type);
    const beans = order.beans.type === 'None' ? '' : (order.beans.portion && order.beans.portion !== 'Regular' ? `${order.beans.portion} ${order.beans.type}` : order.beans.type);
    const premium = order.premiums?.length > 0 ? order.premiums.join('\n') : '';
    return applyReplacements(
      `Order {#}\n{name}\n{entree}\n{protein}\n{rice}\n{beans}\n{toppings}\n{premium}`,
      { '#': String(i + 1), name: info.name || 'N/A', entreeName: order.entreeName || info.name || 'N/A', entree: order.type, protein, rice, beans, toppings, premium }
    ).split('\n').filter(l => l.trim()).join('\n');
  }).join('\n\n');

  return `${header}\n\n${items}`;
}

// ── Select menu shorthand ───────────────────────────────────────────────────

function makeSelect(customId: string, placeholder: string, options: { label: string; value: string }[], extra?: { min?: number; max?: number }) {
  const s = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options);
  if (extra?.min !== undefined) s.setMinValues(extra.min);
  if (extra?.max !== undefined) s.setMaxValues(extra.max);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(s);
}

// ── Order flow screens ─────────────────────────────────────────────────────

function createPortionRow(prefix: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_Light`).setLabel('✨ Light').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}_Regular`).setLabel('✅ Regular').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}_Extra`).setLabel('💪 Extra').setStyle(ButtonStyle.Secondary),
  );
}

async function showPickupTimeSelect(interaction: any, state: any) {
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isStringSelectMenu() || interaction.isButton()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const tz = state.info?.timezone || 'America/Los_Angeles';
  const earliestMinutes = 11 * 60; // manual orders: 11:00 AM
  const options = generatePickupTimeOptions(earliestMinutes, tz);
  const earliestStr = options[0]?.label ?? pstTimeToLocalLabel(11, 0, tz);
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  if (options.length <= 25) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('pickup_time_select').setPlaceholder('🕐 Select your pickup time').addOptions(options)
    ));
  } else {
    for (let i = 0; i < options.length; i += 25) {
      const chunk = options.slice(i, i + 25);
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`pickup_time_select_${Math.floor(i / 25) + 1}`)
          .setPlaceholder(`🕐 ${chunk[0]?.label} — ${chunk[chunk.length - 1]?.label}`)
          .addOptions(chunk)
      ));
    }
  }
  await interaction.editReply({ content: `🕐 **Select your pickup time**\nEarliest: **${earliestStr}**`, components: rows, embeds: [] });
}

async function showEntreeSelect(interaction: any, state: any) {
  const row = makeSelect('entree_select', 'Choose your entree', [
    { label: '🥗 Burrito Bowl', value: 'Burrito Bowl' },
    { label: '🌯 Burrito', value: 'Burrito' },
    { label: '🧀 Quesadilla', value: 'Quesadilla' },
    { label: '🥙 Salad Bowl', value: 'Salad Bowl' },
    { label: '🌮 Tacos', value: 'Tacos' },
  ]);
  const components: any[] = [row];
  if (state.orders?.length > 0) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('back_to_review').setLabel('Back to Review').setStyle(ButtonStyle.Danger)
    ));
  }
  const method = interaction.replied || interaction.deferred ? 'editReply' : (interaction.isButton() || interaction.isStringSelectMenu() ? 'update' : 'reply');
  await interaction[method]({ content: 'Choose your entree:', components, embeds: [], flags: MessageFlags.Ephemeral });
}

async function showProteinSelect(interaction: any, state: any) {
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
  await interaction.update({ content: `Selected: **${state.currentOrder.type}**. Now choose your protein:`, components: [row, backRow] });
}

async function showProteinPortion(interaction: any, state: any) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('protein_double').setLabel('💪 Double Protein').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('protein_skip').setLabel('✅ Regular Portion').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('back_to_protein_select').setLabel('◀️ Back').setStyle(ButtonStyle.Danger),
  );
  await interaction.update({ content: `🥩 Protein: **${state.currentOrder.proteins.join(', ')}**. Double protein?`, components: [row] });
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
  row.addComponents(new ButtonBuilder().setCustomId('back_to_rice_select').setLabel('Back').setStyle(ButtonStyle.Danger));
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
  row.addComponents(new ButtonBuilder().setCustomId('back_to_beans_select').setLabel('Back').setStyle(ButtonStyle.Danger));
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
  await interaction.update({ content: '🥗 Choose your toppings:', components: [row, backRow] });
}

async function showToppingPortion(interaction: any, state: any, index: number) {
  const topping = state.currentOrder.selectedToppings[index];
  const row = createPortionRow(`topping_portion_${index}`);
  const backId = index === 0 ? 'back_to_toppings_select' : `back_to_topping_${index - 1}`;
  row.addComponents(new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger));
  await interaction.update({ content: `🧂 Topping: **${topping}**. Choose portion:`, components: [row] });
}

async function showPremiumSelect(interaction: any, state: any) {
  const row = makeSelect('premium_select', 'Choose Premium Topping(s)', [
    { label: '🥑 Guacamole', value: 'Guacamole' },
    { label: '🫕 Queso', value: 'Queso' },
    { label: '❌ None', value: 'None' },
  ], { min: 1, max: 3 });
  const backId = state.currentOrder.selectedToppings.length === 0
    ? 'back_to_toppings_select'
    : `back_to_topping_${state.currentOrder.selectedToppings.length - 1}`;
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger)
  );
  await interaction.update({ content: '⭐ Add a premium topping (optional):', components: [row, backRow] });
}

async function showCart(interaction: any, state: any) {
  const maxEntrees = Math.min(state.maxEntrees || 8, 8);
  const atMax = state.orders.length >= maxEntrees;
  const remaining = maxEntrees - state.orders.length;
  const addLabel = atMax ? null : (remaining === 1 ? '➕ Add Last Item' : `➕ Add Item (${state.orders.length}/${maxEntrees})`);

  const embed = createEmbed()
    .setTitle('🛒 Your Order Summary')
    .setDescription(`**${state.orders.length}** item(s) in cart.`);

  state.orders.forEach((order: any, i: number) => {
    const protein = order.isDouble ? `Double ${order.proteins[0]}` : order.proteins[0] || 'Veggie';
    const toppings = order.toppings.map((t: any) => t.portion === 'Regular' ? t.type : `${t.portion} ${t.type}`).join(', ') || 'None';
    const rice = order.rice.type === 'None' ? 'No Rice' : `${order.rice.portion !== 'Regular' ? order.rice.portion + ' ' : ''}${order.rice.type}`;
    const beans = order.beans.type === 'None' ? 'No Beans' : `${order.beans.portion !== 'Regular' ? order.beans.portion + ' ' : ''}${order.beans.type}`;
    const premiums = order.premiums?.filter((p: string) => p !== 'None').join(', ') || '';
    const title = order.entreeName ? `${i + 1}. ${order.type} — ${order.entreeName}` : `${i + 1}. ${order.type}`;
    embed.addFields({ name: title, value: `${protein} · ${rice} · ${beans}\n${toppings}${premiums ? '\n' + premiums : ''}` });
  });

  const rowBtns: ButtonBuilder[] = [];
  if (addLabel) rowBtns.push(new ButtonBuilder().setCustomId('add_more').setLabel(addLabel).setStyle(ButtonStyle.Secondary));
  rowBtns.push(
    new ButtonBuilder().setCustomId('edit_order_start').setLabel('✏️ Edit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('remove_item_start').setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('confirm_manual').setLabel('✅ Confirm & Print').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('back_to_premium').setLabel('Back').setStyle(ButtonStyle.Secondary),
  );

  const method = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  await interaction[method]({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(rowBtns)], content: '', flags: MessageFlags.Ephemeral });
}

// ── Main interaction handler ────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /manualorder slash command → show modal
    if (interaction.isChatInputCommand() && interaction.commandName === 'manualorder') {
      const modal = new ModalBuilder().setCustomId('manual_info_modal').setTitle('Manual Order — Customer Info');
      modal.addComponents(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
          new TextInputBuilder().setCustomId('manual_name').setLabel('Name on Order').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
          new TextInputBuilder().setCustomId('manual_zipcode').setLabel('Zip Code').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 90210').setRequired(true)
        ),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
          new TextInputBuilder().setCustomId('manual_phone').setLabel('Phone Number').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
          new TextInputBuilder().setCustomId('manual_email').setLabel('Email').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
          new TextInputBuilder().setCustomId('manual_entrees').setLabel('Number of Entrees (1–8)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 2').setRequired(true)
        ),
      );
      return await interaction.showModal(modal);
    }

    // Modal submit: customer info
    if (interaction.isModalSubmit() && interaction.customId === 'manual_info_modal') {
      const rawPhone = interaction.fields.getTextInputValue('manual_phone');
      if (!/^[+]?[\d\s()\-]{7,20}$/.test(rawPhone)) {
        return await interaction.reply({ content: '❌ Please enter a valid phone number.', flags: MessageFlags.Ephemeral });
      }
      const zipCode = interaction.fields.getTextInputValue('manual_zipcode').replace(/\D/g, '').slice(0, 5);
      if (!/^\d{5}$/.test(zipCode)) {
        return await interaction.reply({ content: '❌ Please enter a valid 5-digit US zip code.', flags: MessageFlags.Ephemeral });
      }
      const parsedEntrees = parseInt(interaction.fields.getTextInputValue('manual_entrees').trim(), 10);
      if (isNaN(parsedEntrees) || parsedEntrees < 1 || parsedEntrees > 8) {
        return await interaction.reply({ content: '❌ Please enter a number of entrees between 1 and 8.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Zip → coordinates
      let lat: number, lng: number, cityName: string, stateAbbr: string;
      try {
        const geoRes = await fetch(`https://api.zippopotam.us/us/${zipCode}`);
        if (!geoRes.ok) throw new Error('Zip not found');
        const geoData: any = await geoRes.json();
        lat = parseFloat(geoData.places[0].latitude);
        lng = parseFloat(geoData.places[0].longitude);
        stateAbbr = geoData.places[0]['state abbreviation'];
        cityName = `${geoData.places[0]['place name']}, ${stateAbbr}`;
      } catch {
        return await interaction.editReply({ content: '❌ Could not find that zip code.' });
      }

      const distMiles = (la1: number, lo1: number, la2: number, lo2: number) => {
        const R = 3958.8, dLat = (la2 - la1) * Math.PI / 180, dLon = (lo2 - lo1) * Math.PI / 180;
        return R * 2 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2));
      };

      const fetchMapTiler = async (): Promise<any[]> => {
        const res = await fetch(`https://api.maptiler.com/geocoding/Chipotle%20Mexican%20Grill.json?proximity=${lng},${lat}&limit=10&types=poi&key=MDqZ9Tw4PuuEnadIszzz`);
        if (!res.ok) throw new Error('MapTiler error');
        const data: any = await res.json();
        return (data.features || []).map((f: any) => {
          const [fLon, fLat] = f.geometry?.coordinates || [0, 0];
          const tags = f.properties?.feature_tags || {};
          return { _lat: fLat, _lon: fLon, _miles: distMiles(lat, lng, fLat, fLon), name: f.text || 'Chipotle', houseNumber: tags['addr:housenumber'] || '', street: tags['addr:street'] || '', city: tags['addr:city'] || '', stateTag: tags['addr:state'] || '', postcode: tags['addr:postcode'] || '' };
        }).filter((s: any) => s._miles <= 25).sort((a: any, b: any) => a._miles - b._miles).slice(0, 5);
      };

      const fetchOverpass = async (): Promise<any[]> => {
        const query = `[out:json][timeout:15];(node["name"~"Chipotle",i](around:40234,${lat},${lng});way["name"~"Chipotle",i](around:40234,${lat},${lng}););out center;`;
        const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
        if (!res.ok) throw new Error('Overpass error');
        const data: any = await res.json();
        return (data.elements || [])
          .filter((e: any) => (e.lat ?? e.center?.lat) != null)
          .map((e: any) => {
            const elLat = e.lat ?? e.center?.lat, elLon = e.lon ?? e.center?.lon, tags = e.tags || {};
            return { _lat: elLat, _lon: elLon, _miles: distMiles(lat, lng, elLat, elLon), name: tags.name || 'Chipotle', houseNumber: tags['addr:housenumber'] || '', street: tags['addr:street'] || '', city: tags['addr:city'] || '', stateTag: tags['addr:state'] || '', postcode: tags['addr:postcode'] || '' };
          })
          .sort((a: any, b: any) => a._miles - b._miles).slice(0, 5);
      };

      let stores: any[] = [];
      try {
        const result = await Promise.allSettled([fetchMapTiler(), fetchOverpass()]);
        const fulfilled = result.find(r => r.status === 'fulfilled' && (r as any).value.length > 0);
        if (!fulfilled) throw new Error('No results');
        stores = (fulfilled as any).value;
      } catch {
        return await interaction.editReply({ content: '❌ Could not retrieve Chipotle locations. Please try again.' });
      }
      if (stores.length === 0) {
        return await interaction.editReply({ content: `❌ No Chipotle locations found within 25 miles of **${zipCode}**.` });
      }

      const tz = resolveTimezone(stateAbbr!);
      orderState.set(`${interaction.user.id}:${interaction.guildId}`, {
        guildId: interaction.guildId,
        maxEntrees: parsedEntrees,
        isManual: true,
        info: {
          name: sanitizeInput(interaction.fields.getTextInputValue('manual_name'), 100),
          location: '', time: '',
          phone: sanitizeInput(rawPhone, 20),
          email: sanitizeInput(interaction.fields.getTextInputValue('manual_email'), 100),
          lat, lng, timezone: tz,
        },
        orders: [],
        currentOrder: { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] },
        editingIndex: null,
        lastUpdated: Date.now(),
      });

      const storeSelect = new StringSelectMenuBuilder()
        .setCustomId('store_select')
        .setPlaceholder('📍 Select your Chipotle location')
        .addOptions(stores.map((store: any, idx: number) => {
          const street = `${store.houseNumber} ${store.street}`.trim();
          const full = `${street}, ${store.city}, ${store.stateTag} ${store.postcode}`.trim().replace(/^,\s*/, '');
          const value = `${idx}:${(full || `${store._lat},${store._lon}`)}`.slice(0, 100);
          return { label: (street || store.city || 'Chipotle').slice(0, 100), description: `${store.city}, ${store.stateTag} — ${store._miles.toFixed(1)} mi`.slice(0, 100), value };
        }));
      await interaction.editReply({ content: `📍 Found **${stores.length}** Chipotle(s) near **${cityName}**. Select your store:`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(storeSelect)] });
      return;
    }

    // All subsequent interactions require state
    const stateKey = `${interaction.user.id}:${interaction.guildId}`;
    const state = orderState.get(stateKey);
    if (!state && (interaction.isButton() || interaction.isStringSelectMenu())) {
      return await interaction.reply({ content: '❌ Session expired. Please use `/manualorder` again.', flags: MessageFlags.Ephemeral });
    }
    if (state) state.lastUpdated = Date.now();

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'store_select') {
        state.info.location = interaction.values[0].replace(/^\d+:/, '');
        await showPickupTimeSelect(interaction, state);
      } else if (interaction.customId === 'pickup_time_select' || interaction.customId.startsWith('pickup_time_select_')) {
        await interaction.deferUpdate();
        state.info.time = interaction.values[0];
        await showEntreeSelect(interaction, state);
      } else if (interaction.customId === 'entree_select') {
        state.currentOrder = { type: interaction.values[0], proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
        await showProteinSelect(interaction, state);
      } else if (interaction.customId === 'protein_select') {
        state.currentOrder.proteins = [interaction.values[0]];
        await showProteinPortion(interaction, state);
      } else if (interaction.customId === 'rice_select') {
        state.currentOrder.rice.type = interaction.values[0];
        if (state.currentOrder.rice.type === 'None') await showBeansSelect(interaction, state);
        else await showRicePortion(interaction, state);
      } else if (interaction.customId === 'beans_select') {
        state.currentOrder.beans.type = interaction.values[0];
        if (state.currentOrder.beans.type === 'None') await showToppingsSelect(interaction, state);
        else await showBeansPortion(interaction, state);
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
        // Ask for name if multi-entree
        if (!isEditing && (state.maxEntrees || 1) > 1) {
          const idx = state.orders.length;
          const modal = new ModalBuilder().setCustomId('item_name_modal').setTitle(`Entree ${idx} — Who is this for?`);
          modal.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder().setCustomId('item_name').setLabel(`Name for entree ${idx} (optional)`).setStyle(TextInputStyle.Short).setRequired(false)
          ));
          await interaction.showModal(modal);
        } else {
          await showCart(interaction, state);
        }
      } else if (interaction.customId.startsWith('edit_select_')) {
        const idx = parseInt(interaction.customId.replace('edit_select_', ''), 10);
        state.editingIndex = idx;
        state.orders.splice(idx, 1);
        state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
        await showEntreeSelect(interaction, state);
      } else if (interaction.customId === 'remove_select') {
        const idx = parseInt(interaction.values[0], 10);
        state.orders.splice(idx, 1);
        await showCart(interaction, state);
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'protein_double') {
        state.currentOrder.isDouble = true;
        await showRiceSelect(interaction, state);
      } else if (interaction.customId === 'protein_skip') {
        state.currentOrder.isDouble = false;
        await showRiceSelect(interaction, state);
      } else if (interaction.customId.startsWith('rice_portion_')) {
        state.currentOrder.rice.portion = interaction.customId.replace('rice_portion_', '');
        await showBeansSelect(interaction, state);
      } else if (interaction.customId.startsWith('beans_portion_')) {
        state.currentOrder.beans.portion = interaction.customId.replace('beans_portion_', '');
        await showToppingsSelect(interaction, state);
      } else if (interaction.customId.startsWith('topping_portion_')) {
        const parts = interaction.customId.split('_');
        const portion = parts.pop()!;
        const index = parseInt(parts.pop()!, 10);
        state.currentOrder.toppings.push({ type: state.currentOrder.selectedToppings[index], portion });
        if (index + 1 < state.currentOrder.selectedToppings.length) {
          await showToppingPortion(interaction, state, index + 1);
        } else {
          await showPremiumSelect(interaction, state);
        }
      } else if (interaction.customId === 'add_more') {
        state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
        await showEntreeSelect(interaction, state);
      } else if (interaction.customId === 'back_to_review') {
        await showCart(interaction, state);
      } else if (interaction.customId === 'edit_order_start') {
        if (state.orders.length === 0) return await interaction.reply({ content: '❌ No items to edit.', flags: MessageFlags.Ephemeral });
        const row = makeSelect('edit_select', 'Select item to edit',
          state.orders.map((o: any, i: number) => ({ label: `${i + 1}. ${o.type}${o.entreeName ? ` — ${o.entreeName}` : ''}`, value: String(i) }))
        );
        await interaction.update({ content: 'Select an item to edit:', components: [row], embeds: [] });
      } else if (interaction.customId.startsWith('edit_select_')) {
        const idx = parseInt(interaction.customId.replace('edit_select_', ''), 10);
        state.editingIndex = idx;
        state.orders.splice(idx, 1);
        state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
        await showEntreeSelect(interaction, state);
      } else if (interaction.customId === 'remove_item_start') {
        if (state.orders.length === 0) return await interaction.reply({ content: '❌ No items to remove.', flags: MessageFlags.Ephemeral });
        const row = makeSelect('remove_select', 'Select item to remove',
          state.orders.map((o: any, i: number) => ({ label: `${i + 1}. ${o.type}${o.entreeName ? ` — ${o.entreeName}` : ''}`, value: String(i) }))
        );
        await interaction.update({ content: 'Select an item to remove:', components: [row], embeds: [] });
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
      } else if (interaction.customId === 'back_to_toppings_select') {
        await showToppingsSelect(interaction, state);
      } else if (interaction.customId.startsWith('back_to_topping_')) {
        const idx = parseInt(interaction.customId.replace('back_to_topping_', ''), 10);
        state.currentOrder.toppings = state.currentOrder.toppings.slice(0, idx);
        await showToppingPortion(interaction, state, idx);
      } else if (interaction.customId === 'back_to_premium') {
        await showCart(interaction, state);
      } else if (interaction.customId === 'confirm_manual') {
        await interaction.deferUpdate();
        const formatted = formatOrder('__manual__', state.info, state.orders);
        const file = new AttachmentBuilder(Buffer.from(formatted, 'utf8'), { name: 'manual_order.txt' });
        orderState.delete(stateKey);
        await interaction.editReply({ content: '✅ Manual order printed.', embeds: [], components: [], files: [file] });
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'item_name_modal') {
      const name = interaction.fields.getTextInputValue('item_name').trim();
      if (name) state.orders[state.orders.length - 1].entreeName = name;
      await interaction.deferUpdate();
      if (state.orders.length >= (state.maxEntrees || 8)) {
        await showCart(interaction, state);
      } else {
        state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premiums: [] };
        await showEntreeSelect(interaction, state);
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
  }
});

// ── Bot startup ────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  const token = process.env.DISCORD_TOKEN!;
  const clientId = process.env.DISCORD_CLIENT_ID!;
  const rest = new REST({ version: '10' }).setToken(token);
  const command = new SlashCommandBuilder()
    .setName('manualorder')
    .setDescription('Create an order and print it in confirmed-order format — no payment required');
  await rest.put(Routes.applicationCommands(clientId), { body: [command.toJSON()] });
  console.log(`✅ Ready — logged in as ${c.user.tag}`);
});

const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('❌ DISCORD_TOKEN missing in .env'); process.exit(1); }
client.login(token);
