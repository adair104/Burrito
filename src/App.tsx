import React, { useEffect, useState } from 'react';

interface DashboardData {
  bot: { online: boolean; username: string; tag: string; guildCount: number };
  today: { orders: number; revenue: number; entrees: number };
  allTime: { orders: number; revenue: number };
  recentOrders: {
    id: string;
    status: string;
    total: number;
    items: string;
    createdAt: string | null;
    guildId: string | null;
  }[];
  timestamp: string;
}

const STATUS_STYLES: Record<string, { label: string; classes: string }> = {
  paid_fulfilled: { label: 'Fulfilled',   classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  paid:           { label: 'Paid',        classes: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  pending:        { label: 'Pending',     classes: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  pending_venmo:  { label: 'Venmo',       classes: 'bg-sky-500/10 text-sky-400 border-sky-500/20' },
  pending_cashapp:{ label: 'Cash App',    classes: 'bg-lime-500/10 text-lime-400 border-lime-500/20' },
  pending_zelle:  { label: 'Zelle',       classes: 'bg-violet-500/10 text-violet-400 border-violet-500/20' },
  pending_crypto: { label: 'Crypto',      classes: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
  cancelled:      { label: 'Cancelled',   classes: 'bg-red-500/10 text-red-400 border-red-500/20' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] || { label: status, classes: 'bg-violet-900/40 text-violet-300 border-violet-700/40' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${s.classes}`}>
      {s.label}
    </span>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[#130E26] border border-[#2A1B50] rounded-2xl p-5 flex flex-col gap-1">
      <span className="text-violet-400/60 text-xs font-medium uppercase tracking-wider">{label}</span>
      <span className="text-2xl font-semibold text-white tabular-nums">{value}</span>
      {sub && <span className="text-violet-400/50 text-xs">{sub}</span>}
    </div>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  async function load() {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error('Failed');
      setData(await res.json());
      setLastRefresh(new Date());
      setError(false);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#0D0A1A] text-white font-sans">
      {/* Top bar */}
      <header className="border-b border-[#2A1B50]/60 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-violet-600 rounded-lg flex items-center justify-center text-lg shadow shadow-violet-600/30">
            🥏
          </div>
          <span className="font-semibold text-sm text-white">Burrito Bot</span>
          <span className="text-violet-400/40 text-sm">Dashboard</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-violet-400/40 text-xs hidden sm:block">
            Updated {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <button
            onClick={load}
            className="text-violet-300 hover:text-white transition-colors text-xs border border-[#2A1B50] rounded-lg px-3 py-1.5 hover:border-violet-600"
          >
            Refresh
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">

        {/* Bot status banner */}
        <div className="flex items-center gap-4 bg-[#130E26] border border-[#2A1B50] rounded-2xl px-5 py-4">
          <div className="w-12 h-12 bg-violet-600/10 border border-violet-600/20 rounded-xl flex items-center justify-center text-2xl flex-shrink-0">
            🤖
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-white">
                {data ? data.bot.username : '—'}
              </span>
              {data?.bot.tag && (
                <span className="text-violet-400/60 text-sm">{data.bot.tag}</span>
              )}
            </div>
            <div className="flex items-center gap-4 mt-1 flex-wrap">
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${data?.bot.online ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                <span className={`text-xs font-medium ${data?.bot.online ? 'text-emerald-400' : 'text-red-400'}`}>
                  {data?.bot.online ? 'Online' : 'Offline'}
                </span>
              </div>
              {data && (
                <span className="text-violet-400/50 text-xs">{data.bot.guildCount} server{data.bot.guildCount !== 1 ? 's' : ''}</span>
              )}
            </div>
          </div>
          {error && (
            <span className="text-red-400 text-xs border border-red-500/20 bg-red-500/10 px-2.5 py-1 rounded-lg">
              API error
            </span>
          )}
        </div>

        {/* Stats grid */}
        <div>
          <h2 className="text-xs font-medium text-violet-400/60 uppercase tracking-wider mb-3">Today</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard
              label="Orders"
              value={data ? String(data.today.orders) : '—'}
              sub="placed today"
            />
            <StatCard
              label="Revenue"
              value={data ? `$${data.today.revenue.toFixed(2)}` : '—'}
              sub="collected today"
            />
            <StatCard
              label="Entrees"
              value={data ? String(data.today.entrees) : '—'}
              sub={data && data.today.orders > 0 ? `avg ${(data.today.entrees / data.today.orders).toFixed(1)}/order` : 'avg —'}
            />
          </div>
        </div>

        <div>
          <h2 className="text-xs font-medium text-violet-400/60 uppercase tracking-wider mb-3">All Time</h2>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Total Orders"
              value={data ? String(data.allTime.orders) : '—'}
              sub="paid orders"
            />
            <StatCard
              label="Total Revenue"
              value={data ? `$${data.allTime.revenue.toFixed(2)}` : '—'}
              sub="all servers"
            />
          </div>
        </div>

        {/* Recent orders table */}
        <div>
          <h2 className="text-xs font-medium text-violet-400/60 uppercase tracking-wider mb-3">Recent Orders</h2>
          <div className="bg-[#130E26] border border-[#2A1B50] rounded-2xl overflow-hidden">
            {!data ? (
              <div className="flex items-center justify-center py-12 text-violet-400/40 text-sm">Loading…</div>
            ) : data.recentOrders.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-violet-400/40 text-sm">No orders yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#2A1B50]">
                      <th className="text-left text-violet-400/60 text-xs font-medium px-5 py-3 uppercase tracking-wider">Order</th>
                      <th className="text-left text-violet-400/60 text-xs font-medium px-4 py-3 uppercase tracking-wider hidden sm:table-cell">Items</th>
                      <th className="text-left text-violet-400/60 text-xs font-medium px-4 py-3 uppercase tracking-wider">Status</th>
                      <th className="text-right text-violet-400/60 text-xs font-medium px-5 py-3 uppercase tracking-wider">Total</th>
                      <th className="text-right text-violet-400/60 text-xs font-medium px-5 py-3 uppercase tracking-wider hidden md:table-cell">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2A1B50]/60">
                    {data.recentOrders.map((order) => (
                      <tr key={order.id} className="hover:bg-violet-900/10 transition-colors">
                        <td className="px-5 py-3.5">
                          <span className="font-mono text-violet-300 text-xs bg-[#1E1540] px-2 py-1 rounded">
                            #{order.id}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-violet-200/70 hidden sm:table-cell max-w-[200px]">
                          <span className="truncate block">{order.items}</span>
                        </td>
                        <td className="px-4 py-3.5">
                          <StatusBadge status={order.status} />
                        </td>
                        <td className="px-5 py-3.5 text-right text-violet-100 tabular-nums">
                          ${order.total.toFixed(2)}
                        </td>
                        <td className="px-5 py-3.5 text-right text-violet-400/50 text-xs hidden md:table-cell whitespace-nowrap">
                          {timeAgo(order.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Commands reference */}
        <div>
          <h2 className="text-xs font-medium text-violet-400/60 uppercase tracking-wider mb-3">Quick Reference</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { cmd: '/order',        desc: 'Start a new order',               tag: 'customer' },
              { cmd: '/reorder',      desc: 'Repeat last order',               tag: 'customer' },
              { cmd: '/hours',        desc: 'View queue round status',         tag: 'customer' },
              { cmd: '/myorders',     desc: 'View your recent orders',         tag: 'customer' },
              { cmd: '/wallet',       desc: 'Check credit balance',            tag: 'customer' },
              { cmd: '/storestatus',  desc: 'Open or close the store',         tag: 'admin' },
              { cmd: '/pause',        desc: 'Pause / resume a round',          tag: 'admin' },
              { cmd: '/admin_orders', desc: 'View and manage orders',          tag: 'admin' },
              { cmd: '/roundsummary', desc: "Round breakdown",                 tag: 'admin' },
              { cmd: '/stats',        desc: "Today's snapshot",                tag: 'admin' },
              { cmd: '/credit',       desc: 'Adjust customer store credit',    tag: 'admin' },
              { cmd: '/exportround',  desc: 'Export one round to CSV',         tag: 'admin' },
            ].map(({ cmd, desc, tag }) => (
              <div key={cmd} className="flex items-center gap-3 bg-[#130E26] border border-[#2A1B50] rounded-xl px-4 py-3">
                <code className="text-violet-400 font-mono text-xs bg-[#1E1540] px-2 py-1 rounded flex-shrink-0">{cmd}</code>
                <span className="text-violet-200/70 text-sm flex-1 min-w-0 truncate">{desc}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${tag === 'admin' ? 'bg-violet-600/10 text-violet-400' : 'bg-[#1E1540] text-violet-400/50'}`}>
                  {tag}
                </span>
              </div>
            ))}
          </div>
        </div>

      </main>

      <footer className="border-t border-[#2A1B50]/60 px-6 py-4 mt-8">
        <p className="text-violet-400/30 text-xs text-center">Burrito Bot — auto-refreshes every 30s</p>
      </footer>
    </div>
  );
}
