import { MARKETS } from './traders.mjs';

const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim()))
  && Number.isFinite(Number(value)) ? Number(value) : null;

/** A failed market is unknown, never an empty position. No prior baseline is overwritten here. */
export async function fetchTrackedSnapshot({ info, user, contexts, clock = Date.now }) {
  const positions = [];
  const marketStatus = {};
  for (const dex of ['', 'xyz']) {
    const markets = dex ? ['xyz:GOLD'] : ['BTC', 'ETH'];
    try {
      const state = await info({ type: 'clearinghouseState', user, dex });
      if (!Array.isArray(state?.assetPositions)) throw Error('Incomplete position snapshot');
      const rows = state.assetPositions.map(row => row.position);
      if (rows.some(row => !row || typeof row.coin !== 'string')) throw Error('Invalid position row');
      positions.push(...rows);
      for (const coin of markets) {
        const position = rows.find(row => row.coin === coin);
        if (position && numeric(position.szi) === null) throw Error('Invalid quantity for ' + coin);
      }
      for (const coin of markets) marketStatus[coin] = { ok: true, at: new Date(clock()).toISOString() };
    } catch (error) {
      for (const coin of markets) marketStatus[coin] = {
        ok: false, at: new Date(clock()).toISOString(), error: error.message || 'Query failed',
      };
    }
  }
  const quantities = MARKETS.map(coin => marketStatus[coin]?.ok
    ? numeric(positions.find(position => position.coin === coin)?.szi ?? 0) : null);
  const levels = Object.fromEntries(MARKETS.map((coin, index) => {
    const ok = marketStatus[coin]?.ok;
    const position = ok ? positions.find(row => row.coin === coin) : null;
    return [coin, {
      quantity: quantities[index], midUsd: numeric(contexts?.[index]?.price),
      entryUsd: position ? numeric(position.entryPx) : null,
      notionalUsd: ok ? position ? numeric(position.positionValue) : 0 : null,
      unrealizedPnlUsd: ok ? position ? numeric(position.unrealizedPnl) : 0 : null,
    }];
  }));
  let hedge = null;
  try {
    const spot = await info({ type: 'spotClearinghouseState', user });
    if (!Array.isArray(spot?.balances)) throw Error('Missing spot balances');
    const spotHype = numeric(spot.balances.find(row => row.coin === 'HYPE')?.total ?? 0);
    const perpHype = marketStatus.BTC?.ok ? numeric(positions.find(row => row.coin === 'HYPE')?.szi ?? 0) : null;
    if (spotHype === null) throw Error('Invalid spot quantity');
    hedge = { spotHype, perpHype, at: new Date(clock()).toISOString(),
      scope: 'Hyperliquid main and xyz perpetuals plus spot' };
  } catch { /* Unknown hedge stays null; perpetuals and other addresses are still usable. */ }
  return { quantities, levels, marketStatus, hedge, complete: quantities.every(Number.isFinite) };
}
