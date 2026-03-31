import React, { useEffect, useState, useCallback, useRef } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DashboardData {
  bot: { online: boolean; username: string; tag: string; guildCount: number };
  today: { orders: number; revenue: number; entrees: number; pendingCount: number; pendingRevenue: number; fulfilledCount: number; avgOrderValue: number; statusBreakdown: Record<string, number> };
  allTime: { orders: number; revenue: number; avgOrderValue: number };
  topItems: { name: string; count: number }[];
  topProteins: { name: string; count: number }[];
  recentOrders: OrderRow[];
  timestamp: string;
}
interface OrderRow { id: string; status: string; total: number; items: string; name: string | null; guildName: string | null; createdAt: string | null; guildId: string | null }
interface PendingOrder { id: string; shortId: string; status: string; total: number; items: string; name: string | null; phone: string | null; email: string | null; location: string | null; time: string | null; guildName: string | null; guildId: string | null; createdAt: string | null }
interface TrendDay { date: string; label: string; orders: number; revenue: number; entrees?: number }
interface ServerStat { guildId: string; name: string; orders: number; revenue: number; pending: number; fulfilled: number; memberCount: number | null; storeOpen: boolean }
interface Customer { userId: string; orders: number; revenue: number; name: string | null; guildName: string | null }
interface BlacklistEntry { userId: string; blockedAt: string | null; reason: string | null }
interface CreditEntry { userId: string; balance: number; lastReason: string | null; lastAdjustment: string | null }
interface GuildConfig { basePrice?: number; bulkPrice?: number; bulkThreshold?: number; venmoHandle?: string; cashappTag?: string; zelleEmail?: string; cryptoAddress?: string; pausedRounds?: number[]; storeOpen?: boolean }

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { label: string; color: string; barColor: string }> = {
  paid_fulfilled: { label: 'FULFILLED', color: '#8B5CF6', barColor: 'bg-[#8B5CF6]' },
  paid:           { label: 'PAID',      color: '#ffffff', barColor: 'bg-white' },
  pending:        { label: 'PENDING',   color: '#a78bfa', barColor: 'bg-[#a78bfa]' },
  pending_venmo:  { label: 'VENMO',     color: '#8B5CF6', barColor: 'bg-[#8B5CF6]' },
  pending_cashapp:{ label: 'CASHAPP',   color: '#7C3AED', barColor: 'bg-[#7C3AED]' },
  pending_zelle:  { label: 'ZELLE',     color: '#c4b5fd', barColor: 'bg-[#c4b5fd]' },
  pending_crypto: { label: 'CRYPTO',    color: '#a78bfa', barColor: 'bg-[#a78bfa]' },
  cancelled:      { label: 'CANCELLED', color: '#ff4444', barColor: 'bg-[#ff4444]' },
};

const ITEM_ICONS: Record<string, string> = { Burrito: '🌯', Bowl: '🥣', Tacos: '🌮', Salad: '🥗', Quesadilla: '🫓', Quesabirria: '🫕' };
const PROTEIN_ICONS: Record<string, string> = { Chicken: '🍗', Steak: '🥩', Barbacoa: '🫕', Carnitas: '🐷', Sofritas: '🌿', Fajita: '🫑', 'Double Chicken': '🍗', 'Double Steak': '🥩' };
const ROUND_SCHEDULE = [
  { num: 1, open: '6:45 AM', placement: '8:45 AM', pickup: '9:30 AM' },
  { num: 2, open: '9:45 AM', placement: '11:45 AM', pickup: '12:30 PM' },
  { num: 3, open: '12:45 PM', placement: '2:45 PM', pickup: '3:30 PM' },
  { num: 4, open: '2:45 PM', placement: '4:45 PM', pickup: '5:30 PM' },
];

// ─── Utilities ────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return '--';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}
function fmtMoney(n: number) { return `$${n.toFixed(2)}`; }
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, opts);
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `HTTP ${res.status}`); }
  return res.json();
}

// ─── Shared Components ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] || { label: status.toUpperCase(), color: '#666666' };
  return (
    <span className="text-xs" style={{ color: s.color, textShadow: `0 0 6px ${s.color}` }}>
      [{s.label}]
    </span>
  );
}

function StatCard({ label, value, sub, accent, delay = 0 }: { label: string; value: string; sub?: string; accent?: string; delay?: number }) {
  const isAccent = !!accent;
  const accentColor = accent?.includes('amber') || accent?.includes('yellow') ? '#a78bfa'
    : accent?.includes('emerald') || accent?.includes('green') ? '#8B5CF6'
    : '#ffffff';
  return (
    <div className="p-4 border border-[#1a1a1a] bg-[#050505] flex flex-col gap-1 animate-fadeInUp transition-all hover:border-[#8B5CF630]"
      style={{ boxShadow: 'inset 0 0 20px rgba(139,92,246,0.03)', animationDelay: `${delay}ms` }}>
      <span className="text-[#444] text-xs uppercase tracking-widest">{label}</span>
      <span className="text-2xl tabular-nums"
        style={{ color: isAccent ? accentColor : '#ffffff', textShadow: isAccent ? `0 0 10px ${accentColor}` : '0 0 6px rgba(255,255,255,0.3)' }}>
        {value}
      </span>
      {sub && <span className="text-[#444] text-xs">{sub}</span>}
    </div>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-[#1a1a1a] bg-[#050505] ${className}`}
      style={{ boxShadow: 'inset 0 0 30px rgba(0,238,238,0.015)' }}>
      {children}
    </div>
  );
}

function SectionHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-xs uppercase tracking-widest flex items-center gap-2" style={{ color: '#8B5CF6', textShadow: '0 0 8px #8B5CF6' }}>
        <span className="text-[#333]">──</span>
        <span>{children}</span>
        <span className="text-[#222]">──────────────────────</span>
      </h2>
      {action}
    </div>
  );
}

function Btn({ children, onClick, variant = 'default', disabled, className = '', size = 'sm' }: {
  children: React.ReactNode; onClick?: () => void;
  variant?: 'default' | 'success' | 'danger' | 'ghost' | 'primary';
  disabled?: boolean; className?: string; size?: 'sm' | 'xs';
}) {
  const styles: Record<string, React.CSSProperties> = {
    default: { borderColor: '#333', color: '#aaa' },
    primary: { borderColor: '#8B5CF6', color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' },
    success: { borderColor: '#8B5CF6', color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' },
    danger:  { borderColor: '#ff4444', color: '#ff4444', textShadow: '0 0 6px #ff4444' },
    ghost:   { borderColor: 'transparent', color: '#555' },
  };
  const sz = size === 'xs' ? 'text-xs px-2 py-0.5' : 'text-xs px-3 py-1';
  return (
    <button onClick={onClick} disabled={disabled}
      className={`border transition-all disabled:opacity-25 disabled:cursor-not-allowed hover:brightness-125 ${sz} ${className}`}
      style={styles[variant]}>
      [ {children} ]
    </button>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 gap-2">
      <span className="text-2xl opacity-30">{icon}</span>
      <span className="text-xs uppercase tracking-widest text-[#333]">{text}</span>
    </div>
  );
}

function Toast({ msg, type }: { msg: string; type: 'ok' | 'err' }) {
  const c = type === 'ok' ? '#8B5CF6' : '#ff4444';
  return (
    <div className="fixed bottom-6 right-6 z-50 px-4 py-3 border text-xs animate-slideInRight"
      style={{ borderColor: c, color: c, textShadow: `0 0 8px ${c}`, background: '#000', boxShadow: `0 0 20px ${c}30` }}>
      {type === 'ok' ? '> ' : '! '}{msg}
    </div>
  );
}

function useToast() {
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);
  const show = useCallback((msg: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3000);
  }, []);
  return { toast, show };
}

// ─── Charts ───────────────────────────────────────────────────────────────────

function HorizBar({ items, iconMap }: { items: { name: string; count: number }[]; iconMap: Record<string, string> }) {
  if (!items.length) return <EmptyState icon="~" text="No data yet." />;
  const max = items[0]?.count || 1;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={item.name} className="flex items-center gap-3">
          <span className="text-[#333] text-xs w-4 text-right">{i + 1}</span>
          <span className="text-sm">{iconMap[item.name] || '·'}</span>
          <span className="text-[#888] text-xs w-28 truncate">{item.name}</span>
          <div className="flex-1 h-px bg-[#1a1a1a] relative">
            <div className="absolute top-0 left-0 h-full bg-[#8B5CF6] bar-grow"
              style={{ width: `${(item.count / max) * 100}%`, boxShadow: '0 0 4px #8B5CF6', animationDelay: `${i * 70}ms` }} />
          </div>
          <span className="text-[#555] text-xs w-6 text-right tabular-nums">{item.count}</span>
        </div>
      ))}
    </div>
  );
}

function BarChart({ days, valueKey, label, color }: { days: TrendDay[]; valueKey: 'revenue' | 'orders' | 'entrees'; label: string; color: string }) {
  if (!days.length) return <EmptyState icon="~" text="No data." />;
  const vals = days.map(d => ((d as any)[valueKey] as number) || 0);
  const max = Math.max(...vals, 1);
  const total = vals.reduce((a, b) => a + b, 0);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[#444] text-xs uppercase tracking-widest">── {label}</p>
        <span className="text-xs tabular-nums" style={{ color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' }}>
          {valueKey === 'revenue' ? fmtMoney(total) : total}
        </span>
      </div>
      <div className="flex items-end gap-1 h-20">
        {days.map((d, i) => {
          const v = (d as any)[valueKey] as number;
          const h = Math.max(v > 0 ? (v / max) * 100 : 0, v > 0 ? 3 : 0);
          const isToday = i === days.length - 1;
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group relative">
              <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-[#050505] border border-[#8B5CF6] text-xs px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none"
                style={{ color: '#8B5CF6', borderColor: '#8B5CF6', boxShadow: '0 0 10px #8B5CF640' }}>
                <p className="text-white">{d.label}</p>
                <p>{valueKey === 'revenue' ? fmtMoney(v) : `${v} ${valueKey}`}</p>
              </div>
              <div className="w-full flex items-end" style={{ height: '4.5rem' }}>
                <div className={`w-full bar-grow-y ${isToday ? '' : 'opacity-30 group-hover:opacity-60'}`}
                  style={{ height: `${h}%`, background: color, boxShadow: isToday ? `0 0 6px ${color}` : 'none', animationDelay: `${i * 40}ms` }} />
              </div>
              <span className="text-[#333] truncate w-full text-center" style={{ fontSize: '0.55rem' }}>
                {d.label.split(' ')[0]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (!total) return <EmptyState icon="~" text="No orders today." />;
  const ORDER = ['paid_fulfilled', 'paid', 'pending', 'pending_venmo', 'pending_cashapp', 'pending_zelle', 'pending_crypto', 'cancelled'];
  const items = ORDER.filter(k => breakdown[k] > 0).map(k => ({
    key: k, label: STATUS_STYLES[k]?.label || k,
    color: STATUS_STYLES[k]?.color || '#666',
    barColor: STATUS_STYLES[k]?.barColor || 'bg-[#666]',
    count: breakdown[k], pct: Math.round((breakdown[k] / total) * 100),
  }));
  return (
    <div className="space-y-3">
      <div className="flex overflow-hidden h-1.5 gap-px">
        {items.map(item => (
          <div key={item.key} className={`${item.barColor} h-full`}
            style={{ width: `${item.pct}%`, boxShadow: `0 0 4px ${item.color}` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {items.map(item => (
          <div key={item.key} className="flex items-center gap-1.5 text-xs">
            <span style={{ color: item.color, textShadow: `0 0 4px ${item.color}` }}>■</span>
            <span className="text-[#555]">{item.label}</span>
            <span className="text-[#888] tabular-nums">{item.count}</span>
            <span className="text-[#333]">({item.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Orders Tab ───────────────────────────────────────────────────────────────

function PendingPanel({ onAction }: { onAction: () => void }) {
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { toast, show } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api('/api/dashboard/pending'); setOrders(d.orders || []); } catch { /**/ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: 'fulfill' | 'cancel') {
    if (action === 'cancel' && !confirm('Cancel this order?')) return;
    setActing(id);
    try {
      await api(`/api/dashboard/orders/${id}/${action}`, { method: 'POST' });
      show(action === 'fulfill' ? 'order fulfilled' : 'order cancelled');
      await load(); onAction();
    } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }

  if (loading) return <EmptyState icon="~" text="loading..." />;
  if (!orders.length) return <EmptyState icon="✓" text="no pending orders" />;

  return (
    <>
      {toast && <Toast {...toast} />}
      <div className="flex justify-between items-center mb-3">
        <span className="text-[#444] text-xs">{orders.length} pending</span>
        <Btn onClick={load} variant="ghost">↻ refresh</Btn>
      </div>
      <div className="space-y-px">
        {orders.map(o => (
          <div key={o.id} className="border border-[#1a1a1a] bg-[#050505]">
            <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-[#0a0a0a] transition-colors"
              onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
              <span className="text-xs bg-[#0a0a0a] border border-[#222] px-2 py-0.5 tabular-nums"
                style={{ color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' }}>#{o.shortId}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[#ccc] text-sm">{o.name || '--'}</span>
                  {o.guildName && <span className="text-[#333] text-xs">/ {o.guildName}</span>}
                </div>
                <span className="text-[#444] text-xs truncate block">{o.items}</span>
              </div>
              <StatusBadge status={o.status} />
              <span className="text-white tabular-nums text-sm" style={{ textShadow: '0 0 6px rgba(255,255,255,0.3)' }}>{fmtMoney(o.total)}</span>
              <span className="text-[#333] text-xs">{timeAgo(o.createdAt)}</span>
              <span className="text-[#333] text-xs">{expanded === o.id ? '▲' : '▼'}</span>
            </div>
            {expanded === o.id && (
              <div className="border-t border-[#111] px-4 py-3 bg-black space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  {o.phone && <div><span className="text-[#333] block uppercase tracking-wider">Phone</span><p className="text-[#888] mt-0.5">{o.phone}</p></div>}
                  {o.email && <div><span className="text-[#333] block uppercase tracking-wider">Email</span><p className="text-[#888] mt-0.5 truncate">{o.email}</p></div>}
                  {o.location && <div className="col-span-2"><span className="text-[#333] block uppercase tracking-wider">Location</span><p className="text-[#888] mt-0.5">{o.location}</p></div>}
                  {o.time && <div><span className="text-[#333] block uppercase tracking-wider">Pickup</span><p className="text-[#888] mt-0.5">{o.time}</p></div>}
                  <div><span className="text-[#333] block uppercase tracking-wider">Order ID</span><p className="text-[#333] mt-0.5 break-all">{o.id}</p></div>
                </div>
                <div className="flex gap-2">
                  <Btn variant="success" onClick={() => act(o.id, 'fulfill')} disabled={acting === o.id}>{acting === o.id ? '...' : '✓ fulfill'}</Btn>
                  <Btn variant="danger" onClick={() => act(o.id, 'cancel')} disabled={acting === o.id}>✕ cancel</Btn>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function AllOrdersPanel({ orders }: { orders: OrderRow[] }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const { toast } = useToast();

  const filtered = orders.filter(o => {
    const matchStatus = filter === 'all' || o.status === filter || (filter === 'pending' && o.status.startsWith('pending'));
    const q = search.toLowerCase();
    return matchStatus && (!q || [o.name, o.id, o.items, o.guildName].some(v => v?.toLowerCase().includes(q)));
  });

  return (
    <>
      {toast && <Toast {...toast} />}
      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <input type="text" placeholder="search name, order id, items, server..." value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 bg-[#050505] border border-[#222] px-3 py-1.5 text-xs text-[#aaa] focus:outline-none focus:border-[#8B5CF6]"
          style={{ transition: 'border-color 0.2s' }} />
        <div className="flex gap-1 flex-wrap">
          {['all', 'pending', 'paid', 'paid_fulfilled', 'cancelled'].map(s => {
            const active = filter === s;
            const c = active ? '#8B5CF6' : '#333';
            return (
              <button key={s} onClick={() => setFilter(s)}
                className="text-xs px-2.5 py-1 border transition-all"
                style={{ borderColor: c, color: c, textShadow: active ? '0 0 6px #8B5CF6' : 'none' }}>
                {s === 'all' ? 'ALL' : STATUS_STYLES[s]?.label || s.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>
      <Card className="overflow-hidden">
        {!filtered.length ? <EmptyState icon="~" text="no orders match" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-[#111]">
                {['ORDER', 'CUSTOMER', 'ITEMS', 'STATUS', 'TOTAL', 'TIME'].map(h => (
                  <th key={h} className={`text-left font-normal px-4 py-2 tracking-widest ${h === 'ITEMS' ? 'hidden md:table-cell' : h === 'TIME' ? 'hidden lg:table-cell' : ''}`}
                    style={{ color: '#333' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody className="divide-y divide-[#0a0a0a]">
                {filtered.map(o => (
                  <tr key={o.id} className="hover:bg-[#080808] transition-colors">
                    <td className="px-4 py-2.5">
                      <span className="text-xs bg-[#0a0a0a] border border-[#1a1a1a] px-1.5 py-0.5 tabular-nums"
                        style={{ color: '#8B5CF6' }}>#{o.id.slice(0, 8)}</span>
                    </td>
                    <td className="px-4 py-2.5"><p className="text-[#888]">{o.name || '--'}</p>{o.guildName && <p className="text-[#333]">{o.guildName}</p>}</td>
                    <td className="px-4 py-2.5 text-[#444] hidden md:table-cell max-w-[160px]"><span className="truncate block">{o.items}</span></td>
                    <td className="px-4 py-2.5"><StatusBadge status={o.status} /></td>
                    <td className="px-4 py-2.5 text-white tabular-nums">{fmtMoney(o.total)}</td>
                    <td className="px-4 py-2.5 text-[#333] hidden lg:table-cell">{timeAgo(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ─── Servers Tab ──────────────────────────────────────────────────────────────

function ServersPanel() {
  const [servers, setServers] = useState<ServerStat[]>([]);
  const [configs, setConfigs] = useState<Record<string, GuildConfig>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [priceForm, setPriceForm] = useState<Record<string, { base: string; bulkPrice: string; bulkThreshold: string }>>({});
  const [paymentForm, setPaymentForm] = useState<Record<string, { venmo: string; cashapp: string; zelle: string; crypto: string }>>({});
  const { toast, show } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api('/api/dashboard/servers');
      setServers(d.servers || []);
      const cfgs: Record<string, GuildConfig> = {};
      await Promise.all((d.servers || []).map(async (s: ServerStat) => {
        try { const c = await api(`/api/dashboard/config/${s.guildId}`); cfgs[s.guildId] = c.config; } catch { /**/ }
      }));
      setConfigs(cfgs);
    } catch { /**/ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggleStore(guildId: string) {
    setToggling(guildId);
    try { await api(`/api/dashboard/servers/${guildId}/toggle`, { method: 'POST' }); await load(); show('store status updated'); } catch (e: any) { show(e.message, 'err'); }
    setToggling(null);
  }
  async function fulfillAll(guildId: string, name: string) {
    if (!confirm(`Fulfill all paid orders for ${name}?`)) return;
    setActing(`fulfill:${guildId}`);
    try { const d = await api(`/api/dashboard/servers/${guildId}/fulfillall`, { method: 'POST' }); show(`fulfilled ${d.fulfilled} orders`); await load(); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function toggleRound(guildId: string, round: number, paused: boolean) {
    setActing(`round:${guildId}:${round}`);
    try {
      await api(`/api/dashboard/servers/${guildId}/rounds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ round, action: paused ? 'resume' : 'pause' }) });
      show(`round ${round} ${paused ? 'resumed' : 'paused'}`); await load();
    } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function savePrice(guildId: string) {
    const f = priceForm[guildId]; if (!f) return;
    setActing(`price:${guildId}`);
    try {
      const body: any = {};
      if (f.base) body.basePrice = parseFloat(f.base);
      if (f.bulkPrice) body.bulkPrice = parseFloat(f.bulkPrice);
      if (f.bulkThreshold) body.bulkThreshold = parseInt(f.bulkThreshold, 10);
      await api(`/api/dashboard/config/${guildId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      show('prices saved'); await load();
    } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function savePayment(guildId: string) {
    const f = paymentForm[guildId]; if (!f) return;
    setActing(`pay:${guildId}`);
    try {
      const body: any = {};
      if (f.venmo) body.venmoHandle = f.venmo;
      if (f.cashapp) body.cashappTag = f.cashapp;
      if (f.zelle) body.zelleEmail = f.zelle;
      if (f.crypto) body.cryptoAddress = f.crypto;
      await api(`/api/dashboard/config/${guildId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      show('payment methods saved'); await load();
    } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }

  if (loading) return <EmptyState icon="~" text="loading..." />;
  if (!servers.length) return <EmptyState icon="~" text="no servers found" />;

  const FIELD = "w-full bg-black border border-[#222] px-3 py-1.5 text-xs text-[#888] focus:outline-none focus:border-[#8B5CF6]";

  return (
    <>
      {toast && <Toast {...toast} />}
      <div className="space-y-px">
        {servers.map(s => {
          const cfg = configs[s.guildId] || {};
          const pausedRounds: number[] = cfg.pausedRounds || [];
          const pf = priceForm[s.guildId] || { base: String(cfg.basePrice || ''), bulkPrice: String(cfg.bulkPrice || ''), bulkThreshold: String(cfg.bulkThreshold || '') };
          const payf = paymentForm[s.guildId] || { venmo: cfg.venmoHandle || '', cashapp: cfg.cashappTag || '', zelle: cfg.zelleEmail || '', crypto: cfg.cryptoAddress || '' };
          return (
            <div key={s.guildId} className="border border-[#1a1a1a] bg-[#050505]">
              <div className="px-5 py-4">
                <div className="flex items-center gap-3 flex-wrap mb-3">
                  <span className="text-sm text-white" style={{ textShadow: '0 0 8px rgba(255,255,255,0.2)' }}>{s.name}</span>
                  {s.memberCount !== null && <span className="text-[#333] text-xs">{s.memberCount.toLocaleString()} members</span>}
                  <span className="ml-auto text-xs"
                    style={{ color: s.storeOpen ? '#8B5CF6' : '#ff4444', textShadow: `0 0 6px ${s.storeOpen ? '#8B5CF6' : '#ff4444'}` }}>
                    [{s.storeOpen ? 'OPEN' : 'CLOSED'}]
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                  {[{ l: 'ORDERS', v: String(s.orders), c: '#888' }, { l: 'REVENUE', v: fmtMoney(s.revenue), c: '#888' },
                    { l: 'PENDING', v: String(s.pending), c: s.pending > 0 ? '#a78bfa' : '#555' },
                    { l: 'FULFILLED', v: String(s.fulfilled), c: s.fulfilled > 0 ? '#8B5CF6' : '#555' }].map(item => (
                    <div key={item.l}>
                      <p className="text-[#333] mb-0.5">{item.l}</p>
                      <p className="tabular-nums text-sm" style={{ color: item.c, textShadow: item.c !== '#555' && item.c !== '#888' ? `0 0 6px ${item.c}` : 'none' }}>{item.v}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-5 pb-4 flex gap-2 flex-wrap border-t border-[#0d0d0d] pt-3">
                <Btn variant={s.storeOpen ? 'danger' : 'success'} onClick={() => toggleStore(s.guildId)} disabled={toggling === s.guildId}>
                  {toggling === s.guildId ? '...' : s.storeOpen ? 'close store' : 'open store'}
                </Btn>
                <Btn variant="primary" onClick={() => fulfillAll(s.guildId, s.name)} disabled={acting === `fulfill:${s.guildId}`}>
                  {acting === `fulfill:${s.guildId}` ? '...' : '✓ fulfill all paid'}
                </Btn>
                <a href={`/api/dashboard/export.csv?guildId=${s.guildId}`} download
                  className="text-xs border border-[#222] text-[#555] hover:border-[#8B5CF6] hover:text-[#8B5CF6] px-3 py-1 transition-all">
                  [ ↓ export csv ]
                </a>
                <Btn variant="ghost" onClick={() => setExpanded(expanded === s.guildId ? null : s.guildId)}>
                  {expanded === s.guildId ? '▲ hide' : '▼ settings'}
                </Btn>
              </div>
              {expanded === s.guildId && (
                <div className="border-t border-[#111] px-5 py-4 bg-black space-y-6">
                  <div>
                    <p className="text-[#333] text-xs uppercase tracking-widest mb-3">── round management</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {ROUND_SCHEDULE.map(r => {
                        const isPaused = pausedRounds.includes(r.num);
                        const key = `round:${s.guildId}:${r.num}`;
                        return (
                          <div key={r.num} className="border p-3 text-xs"
                            style={{ borderColor: isPaused ? '#ff444440' : '#1a1a1a', background: isPaused ? '#ff44440a' : '#000' }}>
                            <p className="text-[#888] mb-0.5">ROUND {r.num}</p>
                            <p className="text-[#333]">opens {r.open}</p>
                            <p className="text-[#333] mb-2">pickup {r.pickup}</p>
                            <Btn size="xs" variant={isPaused ? 'success' : 'danger'} onClick={() => toggleRound(s.guildId, r.num, isPaused)} disabled={acting === key}>
                              {acting === key ? '...' : isPaused ? '▶ resume' : '⏸ pause'}
                            </Btn>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <p className="text-[#333] text-xs uppercase tracking-widest mb-3">── pricing</p>
                    <div className="grid grid-cols-3 gap-3">
                      {[{ label: 'BASE PRICE ($)', key: 'base', placeholder: cfg.basePrice?.toFixed(2) || '5.00' },
                        { label: 'BULK PRICE ($)', key: 'bulkPrice', placeholder: cfg.bulkPrice?.toFixed(2) || 'e.g. 4.00' },
                        { label: 'BULK THRESHOLD', key: 'bulkThreshold', placeholder: cfg.bulkThreshold?.toString() || 'e.g. 3' }].map(f => (
                        <div key={f.key}>
                          <label className="text-[#333] text-xs block mb-1">{f.label}</label>
                          <input type="number" step="0.01" placeholder={f.placeholder}
                            value={(pf as any)[f.key]}
                            onChange={e => setPriceForm(p => ({ ...p, [s.guildId]: { ...pf, [f.key]: e.target.value } }))}
                            className={FIELD} />
                        </div>
                      ))}
                    </div>
                    <Btn className="mt-2" variant="primary" onClick={() => savePrice(s.guildId)} disabled={acting === `price:${s.guildId}`}>
                      {acting === `price:${s.guildId}` ? '...' : 'save prices'}
                    </Btn>
                  </div>
                  <div>
                    <p className="text-[#333] text-xs uppercase tracking-widest mb-3">── payment methods</p>
                    <div className="grid grid-cols-2 gap-3">
                      {[{ label: 'VENMO HANDLE', key: 'venmo', placeholder: '@username' },
                        { label: 'CASH APP $TAG', key: 'cashapp', placeholder: '$cashtag' },
                        { label: 'ZELLE EMAIL/PHONE', key: 'zelle', placeholder: 'email or phone' },
                        { label: 'CRYPTO ADDRESS', key: 'crypto', placeholder: 'wallet address' }].map(f => (
                        <div key={f.key}>
                          <label className="text-[#333] text-xs block mb-1">{f.label}</label>
                          <input type="text" placeholder={f.placeholder}
                            value={(payf as any)[f.key]}
                            onChange={e => setPaymentForm(p => ({ ...p, [s.guildId]: { ...payf, [f.key]: e.target.value } }))}
                            className={FIELD} />
                        </div>
                      ))}
                    </div>
                    <Btn className="mt-2" variant="primary" onClick={() => savePayment(s.guildId)} disabled={acting === `pay:${s.guildId}`}>
                      {acting === `pay:${s.guildId}` ? '...' : 'save payment methods'}
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─── Analytics Tab ────────────────────────────────────────────────────────────

function AnalyticsPanel({ topItems, topProteins, statusBreakdown }: { topItems: { name: string; count: number }[]; topProteins: { name: string; count: number }[]; statusBreakdown: Record<string, number> }) {
  const [revDays, setRevDays] = useState<TrendDay[]>([]);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadingRev, setLoadingRev] = useState(false);
  const [loadingCust, setLoadingCust] = useState(false);

  useEffect(() => {
    setLoadingRev(true);
    api(`/api/dashboard/revenue?days=${period}`).then(d => { setRevDays(d.days || []); setLoadingRev(false); }).catch(() => setLoadingRev(false));
  }, [period]);
  useEffect(() => {
    setLoadingCust(true);
    api('/api/dashboard/customers').then(d => { setCustomers(d.customers || []); setLoadingCust(false); }).catch(() => setLoadingCust(false));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <SectionHeader action={
          <div className="flex gap-1">
            {([7, 30, 90] as const).map(p => {
              const active = period === p;
              return (
                <button key={p} onClick={() => setPeriod(p)}
                  className="text-xs px-2 py-0.5 border transition-all"
                  style={{ borderColor: active ? '#8B5CF6' : '#222', color: active ? '#8B5CF6' : '#444', textShadow: active ? '0 0 6px #8B5CF6' : 'none' }}>
                  {p}d
                </button>
              );
            })}
          </div>
        }>Revenue Trend</SectionHeader>
        <Card className="p-5 space-y-5">
          {loadingRev ? <EmptyState icon="~" text="loading..." /> : (
            <>
              <BarChart days={revDays} valueKey="revenue" label="Revenue" color="#8B5CF6" />
              <BarChart days={revDays} valueKey="orders" label="Orders" color="#a78bfa" />
              <BarChart days={revDays} valueKey="entrees" label="Entrees" color="#ff9933" />
            </>
          )}
        </Card>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div><SectionHeader>Top Items — Today</SectionHeader><Card className="p-5"><HorizBar items={topItems} iconMap={ITEM_ICONS} /></Card></div>
        <div><SectionHeader>Top Proteins — Today</SectionHeader><Card className="p-5"><HorizBar items={topProteins} iconMap={PROTEIN_ICONS} /></Card></div>
      </div>
      {Object.values(statusBreakdown).some(v => v > 0) && (
        <div><SectionHeader>Status Distribution — Today</SectionHeader><Card className="p-5"><StatusBreakdown breakdown={statusBreakdown} /></Card></div>
      )}
      <div>
        <SectionHeader>Top Customers — All Time</SectionHeader>
        <Card className="overflow-hidden">
          {loadingCust ? <EmptyState icon="~" text="loading..." /> : !customers.length ? <EmptyState icon="~" text="no customers yet" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-[#111]">
                  {['#', 'CUSTOMER', 'SERVER', 'ORDERS', 'SPENT'].map(h => (
                    <th key={h} className="text-left font-normal px-4 py-2 tracking-widest" style={{ color: '#333' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-[#0a0a0a]">
                  {customers.map((c, i) => (
                    <tr key={`${c.userId}-${i}`} className="hover:bg-[#080808] transition-colors">
                      <td className="px-4 py-2.5 text-[#333] tabular-nums">{i + 1}</td>
                      <td className="px-4 py-2.5"><p className="text-[#888]">{c.name || 'unknown'}</p><p className="text-[#333]">{c.userId}</p></td>
                      <td className="px-4 py-2.5 text-[#444]">{c.guildName || '--'}</td>
                      <td className="px-4 py-2.5 text-[#888] tabular-nums">{c.orders}</td>
                      <td className="px-4 py-2.5 tabular-nums" style={{ color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' }}>{fmtMoney(c.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Tools Tab ────────────────────────────────────────────────────────────────

function ToolsPanel() {
  const [servers, setServers] = useState<ServerStat[]>([]);
  const [selectedGuild, setSelectedGuild] = useState('');
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [credits, setCredits] = useState<CreditEntry[]>([]);
  const [creditUserId, setCreditUserId] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [dmUserId, setDmUserId] = useState('');
  const [dmMessage, setDmMessage] = useState('');
  const [loadingBL, setLoadingBL] = useState(false);
  const [loadingCR, setLoadingCR] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const { toast, show } = useToast();

  useEffect(() => {
    api('/api/dashboard/servers').then(d => { const s = d.servers || []; setServers(s); if (s.length) setSelectedGuild(s[0].guildId); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!selectedGuild) return;
    setLoadingBL(true); setLoadingCR(true);
    api(`/api/dashboard/blacklist/${selectedGuild}`).then(d => { setBlacklist(d.entries || []); setLoadingBL(false); }).catch(() => setLoadingBL(false));
    api(`/api/dashboard/credits/${selectedGuild}`).then(d => { setCredits(d.credits || []); setLoadingCR(false); }).catch(() => setLoadingCR(false));
  }, [selectedGuild]);

  async function unblacklist(userId: string) {
    setActing(`bl:${userId}`);
    try { await api(`/api/dashboard/blacklist/${selectedGuild}/${userId}`, { method: 'DELETE' }); setBlacklist(b => b.filter(x => x.userId !== userId)); show('user unblocked'); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function adjustCredit() {
    if (!creditUserId || !creditAmount) return;
    setActing('credit');
    try {
      const d = await api(`/api/dashboard/credits/${selectedGuild}/${creditUserId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: parseFloat(creditAmount), reason: creditReason }) });
      show(`new balance: ${fmtMoney(d.balance)}`); setCreditUserId(''); setCreditAmount(''); setCreditReason('');
      const d2 = await api(`/api/dashboard/credits/${selectedGuild}`); setCredits(d2.credits || []);
    } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function sendDm() {
    if (!dmUserId || !dmMessage) return;
    setActing('dm');
    try { await api('/api/dashboard/dm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: dmUserId, message: dmMessage }) }); show('dm sent'); setDmUserId(''); setDmMessage(''); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }

  const FIELD = "w-full bg-black border border-[#222] px-3 py-1.5 text-xs text-[#888] focus:outline-none focus:border-[#8B5CF6]";

  return (
    <>
      {toast && <Toast {...toast} />}
      <div className="space-y-8">
        {servers.length > 1 && (
          <div>
            <label className="text-[#333] text-xs uppercase tracking-widest block mb-2">── server</label>
            <select value={selectedGuild} onChange={e => setSelectedGuild(e.target.value)} className="bg-black border border-[#222] px-3 py-1.5 text-xs text-[#888] focus:outline-none focus:border-[#8B5CF6]">
              {servers.map(s => <option key={s.guildId} value={s.guildId}>{s.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <SectionHeader>Export Orders</SectionHeader>
          <Card className="p-5">
            <p className="text-[#444] text-xs mb-4">download order data as csv file</p>
            <div className="flex flex-wrap gap-3">
              <a href={`/api/dashboard/export.csv${selectedGuild ? `?guildId=${selectedGuild}` : ''}`} download
                className="text-xs border px-3 py-1 transition-all"
                style={{ borderColor: '#8B5CF6', color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' }}>
                [ ↓ export {servers.find(s => s.guildId === selectedGuild)?.name || 'all'} orders ]
              </a>
              <a href="/api/dashboard/export.csv" download className="text-xs border border-[#222] text-[#444] hover:border-[#555] hover:text-[#888] px-3 py-1 transition-all">
                [ ↓ export all servers ]
              </a>
            </div>
          </Card>
        </div>
        <div>
          <SectionHeader>Send DM to Customer</SectionHeader>
          <Card className="p-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label className="text-[#333] text-xs block mb-1">DISCORD USER ID</label><input type="text" placeholder="e.g. 123456789012345678" value={dmUserId} onChange={e => setDmUserId(e.target.value)} className={FIELD} /></div>
              <div><label className="text-[#333] text-xs block mb-1">MESSAGE</label><input type="text" placeholder="your message..." value={dmMessage} onChange={e => setDmMessage(e.target.value)} className={FIELD} /></div>
            </div>
            <Btn variant="primary" onClick={sendDm} disabled={!dmUserId || !dmMessage || acting === 'dm'}>{acting === 'dm' ? '...' : '✉ send dm'}</Btn>
          </Card>
        </div>
        <div>
          <SectionHeader>Store Credits</SectionHeader>
          <Card className="p-5 space-y-4">
            <div>
              <p className="text-[#333] text-xs uppercase tracking-widest mb-3">── adjust credit</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className="text-[#333] text-xs block mb-1">USER ID</label><input type="text" placeholder="discord user id" value={creditUserId} onChange={e => setCreditUserId(e.target.value)} className={FIELD} /></div>
                <div><label className="text-[#333] text-xs block mb-1">AMOUNT</label><input type="number" step="0.01" placeholder="e.g. 5.00 or -2.00" value={creditAmount} onChange={e => setCreditAmount(e.target.value)} className={FIELD} /></div>
                <div><label className="text-[#333] text-xs block mb-1">REASON</label><input type="text" placeholder="e.g. refund" value={creditReason} onChange={e => setCreditReason(e.target.value)} className={FIELD} /></div>
              </div>
              <Btn className="mt-3" variant="primary" onClick={adjustCredit} disabled={!creditUserId || !creditAmount || acting === 'credit'}>{acting === 'credit' ? '...' : 'apply credit'}</Btn>
            </div>
            {loadingCR ? <div className="text-[#333] text-xs py-4">loading...</div>
              : credits.length > 0 ? (
                <div>
                  <p className="text-[#333] text-xs uppercase tracking-widest mb-2">── current balances</p>
                  {credits.map(c => (
                    <div key={c.userId} className="flex items-center gap-3 py-2 border-t border-[#0d0d0d]">
                      <span className="text-[#444] text-xs flex-1 truncate">{c.userId}</span>
                      {c.lastReason && <span className="text-[#333] text-xs hidden sm:block truncate max-w-[150px]">{c.lastReason}</span>}
                      <span className="text-xs tabular-nums" style={{ color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' }}>{fmtMoney(c.balance)}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-[#333] text-xs py-2">no customers with credit balance</p>
            }
          </Card>
        </div>
        <div>
          <SectionHeader>Blacklist</SectionHeader>
          <Card className="overflow-hidden">
            {loadingBL ? <EmptyState icon="~" text="loading..." />
              : !blacklist.length ? <EmptyState icon="✓" text="no blocked users" />
              : <div className="divide-y divide-[#0a0a0a]">
                  {blacklist.map(entry => (
                    <div key={entry.userId} className="px-5 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <span className="text-[#555] text-xs">{entry.userId}</span>
                        {entry.blockedAt && <p className="text-[#333] text-xs mt-0.5">blocked {timeAgo(entry.blockedAt)}</p>}
                        {entry.reason && <p className="text-[#444] text-xs mt-0.5">{entry.reason}</p>}
                      </div>
                      <Btn variant="success" size="xs" onClick={() => unblacklist(entry.userId)} disabled={acting === `bl:${entry.userId}`}>
                        {acting === `bl:${entry.userId}` ? '...' : '✓ unblock'}
                      </Btn>
                    </div>
                  ))}
                </div>
            }
          </Card>
        </div>
      </div>
    </>
  );
}

// ─── Tab / App ─────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'orders' | 'analytics' | 'servers' | 'tools' | 'commands' | 'settings' | 'terminal';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',  label: 'OVERVIEW'  },
  { id: 'orders',    label: 'ORDERS'    },
  { id: 'analytics', label: 'ANALYTICS' },
  { id: 'servers',   label: 'SERVERS'   },
  { id: 'tools',     label: 'TOOLS'     },
  { id: 'commands',  label: 'COMMANDS'  },
  { id: 'settings',  label: 'SETTINGS'  },
  { id: 'terminal',  label: 'TERMINAL'  },
];

// ─── Terminal Panel ───────────────────────────────────────────────────────────

function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    async function init() {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');
      const term = new Terminal({
        theme: {
          background: '#000000', foreground: '#cccccc', cursor: '#8B5CF6', cursorAccent: '#000',
          selectionBackground: '#8B5CF640',
          black: '#000', red: '#ff4444', green: '#8B5CF6', yellow: '#a78bfa',
          blue: '#3399ff', magenta: '#cc66ff', cyan: '#8B5CF6', white: '#cccccc',
          brightBlack: '#444', brightRed: '#ff6666', brightGreen: '#00ffff',
          brightYellow: '#ffdd44', brightBlue: '#55aaff', brightMagenta: '#dd88ff',
          brightCyan: '#44dddd', brightWhite: '#ffffff',
        },
        fontFamily: "'WinCmd', 'Courier New', monospace",
        fontSize: 13, lineHeight: 1.4, cursorBlink: true, cursorStyle: 'block', scrollback: 5000, allowTransparency: true,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon); term.loadAddon(new WebLinksAddon());
      if (containerRef.current) { term.open(containerRef.current); fitAddon.fit(); }
      termRef.current = term; fitRef.current = fitAddon;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/terminal`);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'output') term.write(m.data); } catch { /**/ } };
      ws.onclose = () => term.writeln('\r\n\x1b[31m[connection closed]\x1b[0m');
      term.onData((d: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d })); });
    }
    init().catch(console.error);
    const onResize = () => fitRef.current?.fit();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); wsRef.current?.close(); termRef.current?.dispose(); };
  }, []);
  useEffect(() => { setTimeout(() => fitRef.current?.fit(), 50); });

  return (
    <div className="flex flex-col h-[calc(100vh-160px)]">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs uppercase tracking-widest" style={{ color: '#8B5CF6', textShadow: '0 0 6px #8B5CF6' }}>── terminal</span>
        <button onClick={() => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'input', data: '\x0c' })); }}
          className="text-xs border border-[#222] text-[#444] hover:border-[#8B5CF6] hover:text-[#8B5CF6] px-3 py-1 transition-all">
          [ clear ]
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden border border-[#1a1a1a]" style={{ padding: '12px', background: '#000' }} />
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function SettingsPanel() {
  const { toast, show } = useToast();
  const [guilds, setGuilds] = useState<{ id: string; name: string }[]>([]);
  const [selectedGuild, setSelectedGuild] = useState('');
  const [cookie, setCookie] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [preview, setPreview] = useState<{ cashappCookieSet: boolean; cashappCookiePreview: string; webhookUrl: string; discordToken: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api('/api/dashboard/guilds').then(d => {
      setGuilds(d.guilds || []);
      if (d.guilds?.length) setSelectedGuild(d.guilds[0].id);
    }).catch(() => {});
    api('/api/settings').then(d => setPreview(d)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedGuild) return;
    api(`/api/settings?guildId=${selectedGuild}`).then(d => {
      setPreview(d);
      setWebhookUrl(d.webhookUrl || '');
    }).catch(() => {});
  }, [selectedGuild]);

  async function saveCookie() {
    if (!cookie.trim()) return show('paste your cash_web_session cookie first', 'err');
    if (!selectedGuild) return show('select a server first', 'err');
    setSaving('cookie');
    try {
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guildId: selectedGuild, cashappCookie: cookie.trim() }) });
      show('cash app cookie saved');
      setCookie('');
      const d = await api(`/api/settings?guildId=${selectedGuild}`);
      setPreview(d);
    } catch (e: any) { show(e.message, 'err'); }
    setSaving(null);
  }

  async function saveWebhook() {
    if (!selectedGuild) return show('select a server first', 'err');
    setSaving('webhook');
    try {
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guildId: selectedGuild, webhookUrl: webhookUrl.trim() }) });
      show('webhook url saved');
      const d = await api(`/api/settings?guildId=${selectedGuild}`);
      setPreview(d);
    } catch (e: any) { show(e.message, 'err'); }
    setSaving(null);
  }

  const FIELD = "w-full bg-black border border-[#222] px-3 py-1.5 text-xs text-[#888] focus:outline-none focus:border-[#8B5CF6]";
  const SELECT = "bg-black border border-[#222] px-3 py-1.5 text-xs text-[#888] focus:outline-none focus:border-[#8B5CF6] w-full";

  return (
    <>
      {toast && <Toast {...toast} />}
      <div className="space-y-8">

        <div>
          <SectionHeader>Server</SectionHeader>
          <Card className="p-5 space-y-2">
            <p className="text-[#444] text-xs">settings below are saved per-server — each server has completely isolated credentials</p>
            <select value={selectedGuild} onChange={e => setSelectedGuild(e.target.value)} className={SELECT}>
              {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Card>
        </div>

        <div>
          <SectionHeader>Cash App Session Cookie</SectionHeader>
          <Card className="p-5 space-y-4">
            <p className="text-[#444] text-xs">used to auto-verify incoming cash app payments for the selected server only</p>
            {preview && (
              <div className="text-xs px-3 py-2 border"
                style={{ borderColor: preview.cashappCookieSet ? '#8B5CF6' : '#a78bfa', color: preview.cashappCookieSet ? '#8B5CF6' : '#a78bfa', textShadow: `0 0 6px ${preview.cashappCookieSet ? '#8B5CF6' : '#a78bfa'}` }}>
                {preview.cashappCookieSet ? `> cookie set: ${preview.cashappCookiePreview}` : '! no cookie set -- manual verification only'}
              </div>
            )}
            <div>
              <label className="text-[#333] text-xs block mb-1">NEW COOKIE VALUE</label>
              <p className="text-[#333] text-xs mb-2">cash.app → devtools → application → cookies → copy <code>cash_web_session</code></p>
              <textarea rows={3} placeholder="eyJ1c2VyX3Nlc3Npb25..." value={cookie} onChange={e => setCookie(e.target.value)} className={`${FIELD} resize-none`} />
            </div>
            <Btn variant="primary" onClick={saveCookie} disabled={saving === 'cookie'}>{saving === 'cookie' ? '...' : 'save cookie'}</Btn>
          </Card>
        </div>

        <div>
          <SectionHeader>Discord Webhook</SectionHeader>
          <Card className="p-5 space-y-4">
            <p className="text-[#444] text-xs">order alerts for this server only — each server routes to its own channel</p>
            <div><label className="text-[#333] text-xs block mb-1">WEBHOOK URL</label><input type="text" placeholder="https://discord.com/api/webhooks/..." value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} className={FIELD} /></div>
            <Btn variant="primary" onClick={saveWebhook} disabled={saving === 'webhook'}>{saving === 'webhook' ? '...' : 'save webhook'}</Btn>
          </Card>
        </div>

        <div>
          <SectionHeader>Discord Bot Token</SectionHeader>
          <Card className="p-5 space-y-3">
            <p className="text-[#444] text-xs">shared by all servers — edit <code className="text-[#555]">DISCORD_TOKEN</code> in <code className="text-[#555]">.env</code> and restart to change</p>
            {preview && (
              <div className="text-xs px-3 py-2 border border-[#1a1a1a] text-[#333]">
                &gt; {preview.discordToken || '(not set)'}
              </div>
            )}
          </Card>
        </div>

      </div>
    </>
  );
}

// ─── Commands Panel ───────────────────────────────────────────────────────────

function CommandsPanel() {
  const { toast, show } = useToast();
  const [guilds, setGuilds] = useState<{ id: string; name: string; memberCount: number }[]>([]);
  const [selectedGuild, setSelectedGuild] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const [announceMsg, setAnnounceMsg] = useState('');
  const [announceTarget, setAnnounceTarget] = useState('all');
  const [batchOrders, setBatchOrders] = useState<any[]>([]);
  const [batchLoaded, setBatchLoaded] = useState(false);
  const [roundSummary, setRoundSummary] = useState<{ total: number; paid: number; pending: number; revenue: number } | null>(null);

  useEffect(() => { api('/api/dashboard/guilds').then(d => { setGuilds(d.guilds || []); if (d.guilds?.length) setSelectedGuild(d.guilds[0].id); }).catch(() => {}); }, []);

  async function sendAnnouncement() {
    if (!announceMsg.trim()) return show('enter a message first', 'err');
    setActing('announce');
    try { const body: any = { message: announceMsg }; if (announceTarget !== 'all') body.guildId = announceTarget; const d = await api('/api/dashboard/announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); show(`sent to ${d.sent} server(s)`); setAnnounceMsg(''); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function loadBatch() {
    if (!selectedGuild) return; setActing('loadbatch');
    try { const d = await api(`/api/dashboard/batch/${selectedGuild}`); setBatchOrders(d.orders || []); setBatchLoaded(true); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function clearBatch() {
    if (!selectedGuild) return; setActing('clearbatch');
    try { const d = await api(`/api/dashboard/batch/${selectedGuild}/clear`, { method: 'POST' }); show(`cleared ${d.cleared} order(s)`); setBatchOrders([]); setBatchLoaded(false); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function loadRoundSummary() {
    if (!selectedGuild) return; setActing('roundsummary');
    try { const d = await api(`/api/dashboard/roundsummary/${selectedGuild}`); setRoundSummary(d); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }
  async function fulfillAll() {
    if (!selectedGuild) return; setActing('fulfillall');
    try { const d = await api(`/api/dashboard/servers/${selectedGuild}/fulfillall`, { method: 'POST' }); show(`fulfilled ${d.count} order(s)`); } catch (e: any) { show(e.message, 'err'); }
    setActing(null);
  }

  const FIELD = "w-full bg-black border border-[#222] px-3 py-1.5 text-xs text-[#888] focus:outline-none focus:border-[#8B5CF6]";
  const SELECT = "bg-black border border-[#222] px-3 py-1.5 text-xs text-[#888] focus:outline-none focus:border-[#8B5CF6] w-full";

  return (
    <>
      {toast && <Toast {...toast} />}
      <div className="space-y-8">
        {guilds.length > 1 && (<div><label className="text-[#333] text-xs uppercase tracking-widest block mb-2">── target server</label><select value={selectedGuild} onChange={e => setSelectedGuild(e.target.value)} className={SELECT}>{guilds.map(g => <option key={g.id} value={g.id}>{g.name} ({g.memberCount} members)</option>)}</select></div>)}
        <div>
          <SectionHeader>Broadcast Announcement</SectionHeader>
          <Card className="p-5 space-y-3">
            <p className="text-[#444] text-xs">send a message to one or all server webhook channels</p>
            <div><label className="text-[#333] text-xs block mb-1">TARGET</label><select value={announceTarget} onChange={e => setAnnounceTarget(e.target.value)} className={SELECT}><option value="all">all servers</option>{guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
            <div><label className="text-[#333] text-xs block mb-1">MESSAGE</label><textarea rows={3} placeholder="@everyone orders are open! use /order to place your order." value={announceMsg} onChange={e => setAnnounceMsg(e.target.value)} className={`${FIELD} resize-none`} /></div>
            <Btn variant="primary" onClick={sendAnnouncement} disabled={acting === 'announce'}>{acting === 'announce' ? '...' : 'send announcement'}</Btn>
          </Card>
        </div>
        <div>
          <SectionHeader>Fulfill All Paid Orders</SectionHeader>
          <Card className="p-5 space-y-3">
            <p className="text-[#444] text-xs">mark all paid-but-unfulfilled orders as fulfilled and notify customers</p>
            <Btn variant="success" onClick={fulfillAll} disabled={acting === 'fulfillall' || !selectedGuild}>{acting === 'fulfillall' ? '...' : '✓ fulfill all'}</Btn>
          </Card>
        </div>
        <div>
          <SectionHeader>Today's Round Summary</SectionHeader>
          <Card className="p-5 space-y-3">
            <p className="text-[#444] text-xs">summary of all orders placed today for the selected server</p>
            <Btn onClick={loadRoundSummary} disabled={acting === 'roundsummary' || !selectedGuild}>{acting === 'roundsummary' ? '...' : 'load summary'}</Btn>
            {roundSummary && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[#111] mt-2">
                <StatCard label="Total" value={String(roundSummary.total)} />
                <StatCard label="Paid" value={String(roundSummary.paid)} accent="text-emerald-400" />
                <StatCard label="Pending" value={String(roundSummary.pending)} accent={roundSummary.pending > 0 ? 'text-amber-400' : undefined} />
                <StatCard label="Revenue" value={fmtMoney(roundSummary.revenue)} accent="text-emerald-400" />
              </div>
            )}
          </Card>
        </div>
        <div>
          <SectionHeader>Batch Management</SectionHeader>
          <Card className="p-5 space-y-3">
            <p className="text-[#444] text-xs">view and clear the current order batch</p>
            <div className="flex gap-2 flex-wrap">
              <Btn onClick={loadBatch} disabled={acting === 'loadbatch' || !selectedGuild}>{acting === 'loadbatch' ? '...' : 'view batch'}</Btn>
              {batchLoaded && batchOrders.length > 0 && <Btn variant="danger" onClick={clearBatch} disabled={acting === 'clearbatch'}>{acting === 'clearbatch' ? '...' : 'clear batch'}</Btn>}
            </div>
            {batchLoaded && (batchOrders.length === 0 ? <p className="text-[#333] text-xs">no orders in current batch</p> : (
              <div className="divide-y divide-[#0d0d0d]">
                {batchOrders.map((o: any) => (
                  <div key={o.id} className="py-2 flex items-center gap-3">
                    <code className="text-[#444] text-xs">{o.id}</code>
                    <span className="text-[#666] text-xs flex-1 truncate">{o.items || '--'}</span>
                    <StatusBadge status={o.status} />
                    <span className="text-xs tabular-nums" style={{ color: '#8B5CF6' }}>{fmtMoney(o.total || 0)}</span>
                  </div>
                ))}
              </div>
            ))}
          </Card>
        </div>
        <div>
          <SectionHeader>Discord Commands Reference</SectionHeader>
          <Card className="overflow-hidden">
            <div className="divide-y divide-[#0a0a0a]">
              {[
                { cmd: '/order', desc: 'start a new chipotle order', who: 'customer' },
                { cmd: '/reorder', desc: 'repeat your last order instantly', who: 'customer' },
                { cmd: '/myorders', desc: 'check your recent order statuses', who: 'customer' },
                { cmd: '/menu', desc: 'view the full chipotle menu', who: 'customer' },
                { cmd: '/schedule', desc: 'view queue times and pickup rules', who: 'customer' },
                { cmd: '/wallet', desc: 'check your credit balance', who: 'customer' },
                { cmd: '/hours', desc: "view today's queue schedule", who: 'customer' },
                { cmd: '/support', desc: 'get help with an order issue', who: 'customer' },
                { cmd: '/setup main', desc: 'configure webhooks, pricing, payments', who: 'admin' },
                { cmd: '/storestatus', desc: 'open or close the store', who: 'admin' },
                { cmd: '/pause', desc: 'pause or resume ordering rounds', who: 'admin' },
                { cmd: '/fulfillall', desc: 'fulfill all paid orders at once', who: 'admin' },
                { cmd: '/credit', desc: 'add or deduct customer credit', who: 'admin' },
                { cmd: '/blacklist', desc: 'block a user from ordering', who: 'admin' },
                { cmd: '/announcements', desc: 'broadcast message to all servers', who: 'admin' },
                { cmd: '/dm', desc: 'send a dm to a specific customer', who: 'admin' },
                { cmd: '/revenue', desc: 'view revenue stats', who: 'admin' },
                { cmd: '/stats', desc: 'view server order statistics', who: 'admin' },
                { cmd: '/export', desc: 'export orders as a file', who: 'admin' },
                { cmd: '/roundsummary', desc: "summary of today's rounds", who: 'admin' },
                { cmd: '/format', desc: 'customize order output format', who: 'admin' },
                { cmd: '/branding', desc: 'update bot display name and colors', who: 'admin' },
              ].map(r => (
                <div key={r.cmd} className="px-5 py-2 flex items-center gap-3 hover:bg-[#080808] transition-colors">
                  <code className="text-xs w-36 shrink-0" style={{ color: '#8B5CF6', textShadow: '0 0 4px #8B5CF6' }}>{r.cmd}</code>
                  <span className="text-[#444] text-xs flex-1">{r.desc}</span>
                  <span className="text-xs px-1.5 py-0 border"
                    style={{ borderColor: r.who === 'admin' ? '#a78bfa40' : '#1a1a1a', color: r.who === 'admin' ? '#a78bfa' : '#333', textShadow: r.who === 'admin' ? '0 0 4px #a78bfa' : 'none' }}>
                    [{r.who}]
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [countdown, setCountdown] = useState(30);
  const [tab, setTab] = useState<Tab>('overview');
  const [orderTab, setOrderTab] = useState<'pending' | 'all'>('pending');

  const load = useCallback(async () => {
    try { const res = await fetch('/api/dashboard'); if (res.ok) { setData(await res.json()); setError(false); } else setError(true); } catch { setError(true); }
    setLastRefresh(new Date()); setCountdown(30);
  }, []);
  useEffect(() => { load(); const i = setInterval(load, 30_000); return () => clearInterval(i); }, [load]);
  useEffect(() => { const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000); return () => clearInterval(t); }, [lastRefresh]);

  const fulfilmentRate = data && data.today.orders > 0 ? Math.round((data.today.fulfilledCount / data.today.orders) * 100) : null;

  return (
    <div className="min-h-screen bg-black text-[#cccccc]">

      {/* Header */}
      <header className="border-b border-[#1a1a1a] px-6 py-3 flex items-center justify-between sticky top-0 z-20"
        style={{ background: 'rgba(0,0,0,0.96)', backdropFilter: 'blur(4px)' }}>
        <div className="flex items-center gap-4">
          <img src="/logo.png" alt="" className="w-6 h-6 opacity-80 animate-float" />
          <span className="text-sm tracking-widest animate-flicker" style={{ color: '#8B5CF6', textShadow: '0 0 10px #8B5CF6' }}>BURRITO BOT</span>
          {data?.bot.online && (
            <span className="flex items-center gap-2 text-xs">
              <span className="glow-pulse" style={{ color: '#8B5CF6' }}>●</span>
              <span className="text-[#444]">{data.bot.tag}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[#222] text-xs hidden sm:block">REFRESH IN {countdown}s</span>
          <button onClick={load}
            className="text-xs border border-[#222] text-[#444] hover:border-[#8B5CF6] hover:text-[#8B5CF6] px-3 py-1 transition-all">
            [ ↻ REFRESH ]
          </button>
          {error && <span className="text-xs border px-2 py-1" style={{ borderColor: '#ff4444', color: '#ff4444', textShadow: '0 0 6px #ff4444' }}>! API ERROR</span>}
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-[#1a1a1a] px-2 flex overflow-x-auto">
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="px-4 py-3 text-xs whitespace-nowrap transition-all flex-shrink-0 flex items-center gap-2"
              style={{
                color: active ? '#000' : '#333',
                background: active ? '#8B5CF6' : 'transparent',
                textShadow: active ? 'none' : 'none',
                boxShadow: active ? '0 0 20px #8B5CF660' : 'none',
              }}>
              {t.label}
              {t.id === 'orders' && data && data.today.pendingCount > 0 && (
                <span className="text-xs px-1.5 py-0 border"
                  style={{ borderColor: active ? '#000' : '#a78bfa60', color: active ? '#000' : '#a78bfa', background: active ? '#00000030' : 'transparent' }}>
                  {data.today.pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <div key={tab} className="space-y-8 animate-fadeInUp">

        {tab === 'overview' && (
          <>
            {/* Bot status */}
            <div className="border border-[#1a1a1a] bg-[#050505] px-5 py-4 flex items-center gap-4"
              style={{ boxShadow: '0 0 30px rgba(0,238,238,0.04), inset 0 0 30px rgba(0,238,238,0.01)' }}>
              <div className="flex-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-white tracking-widest">{data?.bot.username || '--'}</span>
                  {data?.bot.tag && <span className="text-[#333] text-xs">{data.bot.tag}</span>}
                  <span className="text-xs ml-auto"
                    style={{ color: data?.bot.online ? '#8B5CF6' : '#ff4444', textShadow: `0 0 8px ${data?.bot.online ? '#8B5CF6' : '#ff4444'}` }}>
                    [{data?.bot.online ? 'ONLINE' : 'OFFLINE'}]
                  </span>
                  {data && <span className="text-[#333] text-xs">{data.bot.guildCount} server{data.bot.guildCount !== 1 ? 's' : ''}</span>}
                </div>
              </div>
            </div>

            <div>
              <SectionHeader>Today</SectionHeader>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[#111]">
                <StatCard label="ORDERS"    value={data ? String(data.today.orders) : '--'}          sub="placed today" delay={0} />
                <StatCard label="REVENUE"   value={data ? fmtMoney(data.today.revenue) : '--'}       sub="collected today" delay={50} />
                <StatCard label="ENTREES"   value={data ? String(data.today.entrees) : '--'}         sub={data && data.today.orders > 0 ? `avg ${(data.today.entrees / data.today.orders).toFixed(1)}/order` : 'avg --'} delay={100} />
                <StatCard label="AVG ORDER" value={data ? fmtMoney(data.today.avgOrderValue) : '--'} sub="per order" delay={150} />
                <StatCard label="PENDING"   value={data ? String(data.today.pendingCount) : '--'}
                  sub={data ? `${fmtMoney(data.today.pendingRevenue)} uncollected` : undefined}
                  accent={data && data.today.pendingCount > 0 ? 'text-amber-400' : undefined} delay={200} />
                <StatCard label="FULFILLED" value={data ? `${data.today.fulfilledCount}${fulfilmentRate !== null ? ` (${fulfilmentRate}%)` : ''}` : '--'}
                  sub="paid & sent" accent={data && data.today.fulfilledCount > 0 ? 'text-emerald-400' : undefined} delay={250} />
              </div>
            </div>

            {data && data.today.orders > 0 && (
              <div><SectionHeader>Status Breakdown — Today</SectionHeader><Card className="p-5"><StatusBreakdown breakdown={data.today.statusBreakdown} /></Card></div>
            )}

            <div>
              <SectionHeader>All Time</SectionHeader>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-[#111]">
                <StatCard label="TOTAL ORDERS"  value={data ? String(data.allTime.orders) : '--'}          sub="paid orders"  delay={0} />
                <StatCard label="TOTAL REVENUE" value={data ? fmtMoney(data.allTime.revenue) : '--'}       sub="all servers"  delay={60} />
                <StatCard label="AVG ORDER"     value={data ? fmtMoney(data.allTime.avgOrderValue) : '--'} sub="all time"     delay={120} />
              </div>
            </div>

            <div>
              <SectionHeader>Quick Reference</SectionHeader>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-[#0d0d0d]">
                {[
                  { cmd: '/order', desc: 'start a new order', tag: 'customer' },
                  { cmd: '/reorder', desc: 'repeat last order', tag: 'customer' },
                  { cmd: '/hours', desc: 'view queue round status', tag: 'customer' },
                  { cmd: '/manualorder', desc: 'create order without payment', tag: 'customer' },
                  { cmd: '/storestatus', desc: 'open or close the store', tag: 'admin' },
                  { cmd: '/pause', desc: 'pause / resume a round', tag: 'admin' },
                  { cmd: '/roundsummary', desc: 'round breakdown', tag: 'admin' },
                  { cmd: '/stats', desc: "today's snapshot", tag: 'admin' },
                  { cmd: '/credit', desc: 'adjust store credit', tag: 'admin' },
                  { cmd: '/export', desc: 'export all orders to csv', tag: 'admin' },
                  { cmd: '/fulfillall', desc: 'mark all paid as fulfilled', tag: 'admin' },
                  { cmd: '/dm', desc: 'dm a customer', tag: 'admin' },
                ].map(({ cmd, desc, tag }) => (
                  <div key={cmd} className="flex items-center gap-3 bg-[#050505] px-4 py-3 hover:bg-[#0a0a0a] transition-colors">
                    <code className="text-xs w-32 shrink-0" style={{ color: '#8B5CF6', textShadow: '0 0 4px #8B5CF6' }}>{cmd}</code>
                    <span className="text-[#444] text-xs flex-1 min-w-0 truncate">{desc}</span>
                    <span className="text-xs border px-1 py-0 shrink-0"
                      style={{ borderColor: tag === 'admin' ? '#a78bfa40' : '#1a1a1a', color: tag === 'admin' ? '#a78bfa' : '#333', textShadow: tag === 'admin' ? '0 0 4px #a78bfa' : 'none' }}>
                      [{tag}]
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === 'orders' && (
          <>
            <div className="flex gap-px bg-[#111] w-fit">
              {(['pending', 'all'] as const).map(t => {
                const active = orderTab === t;
                return (
                  <button key={t} onClick={() => setOrderTab(t)}
                    className="text-xs px-4 py-2 transition-all flex items-center gap-2"
                    style={{ background: active ? '#8B5CF6' : '#050505', color: active ? '#000' : '#333', boxShadow: active ? '0 0 15px #8B5CF650' : 'none' }}>
                    {t === 'pending' ? `PENDING${data && data.today.pendingCount > 0 ? ` (${data.today.pendingCount})` : ''}` : 'ALL RECENT'}
                  </button>
                );
              })}
            </div>
            {orderTab === 'pending' ? <PendingPanel onAction={load} /> : <AllOrdersPanel orders={data?.recentOrders || []} />}
          </>
        )}

        {tab === 'analytics' && <AnalyticsPanel topItems={data?.topItems || []} topProteins={data?.topProteins || []} statusBreakdown={data?.today.statusBreakdown || {}} />}
        {tab === 'servers' && (<><SectionHeader>Server Management</SectionHeader><ServersPanel /></>)}
        {tab === 'tools' && <ToolsPanel />}
        {tab === 'commands' && <CommandsPanel />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'terminal' && <TerminalPanel />}

      </div>
      </main>

      <footer className="border-t border-[#0d0d0d] px-6 py-3 mt-8">
        <p className="text-xs text-center" style={{ color: '#1a1a1a' }}>
          BURRITO BOT DASHBOARD // AUTO-REFRESH EVERY 30S // LAST UPDATE: {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      </footer>
    </div>
  );
}
