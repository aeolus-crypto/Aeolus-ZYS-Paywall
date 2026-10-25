'use strict';

const fetch = require('node-fetch');

function getRpcUrl() {
  return process.env.WALLET_RPC_URL || 'http://127.0.0.1:17777/json_rpc';
}

async function rpc(method, params = {}) {
  const res = await fetch(getRpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

async function createAddress(label = '') {
  const result = await rpc('create_address', { account_index: 0, label });
  return { address: result.address, address_index: result.address_index };
}

async function getIncomingTransfers() {
  try {
    const result = await rpc('get_transfers', { in: true, pending: true, account_index: 0 });
    const transfers = (result.in || []).concat(result.pending || []);
    return transfers.filter(t => t.asset_type === 'ZYS' || t.asset_type === 'ZEPHYR_YIELD_STABLE');
  } catch { return []; }
}

async function getZysRate() {
  try {
    const result = await rpc('get_reserve_info', {});

    // zyield_reserve = ZSD held in yield reserve (atomic)
    // num_zyield     = total ZYS supply (atomic)
    const zsdInYield = BigInt(result.zyield_reserve || '0');
    const totalZys   = BigInt(result.num_zyield     || '0');

    if (!totalZys || !zsdInYield) {
      console.error('[wallet] reserve fields missing or zero');
      return null;
    }

    const zsdInYieldF = Number(zsdInYield) / 1e12;
    const totalZysF   = Number(totalZys)   / 1e12;

    const zysToZsd = zsdInYieldF / totalZysF;
    console.log(`[wallet] 1 ZYS = ${zysToZsd.toFixed(6)} ZSD`);
    return zysToZsd;
  } catch (e) {
    console.error('[wallet] get_reserve_info failed:', e.message);
    return null;
  }
}

async function testConnection() {
  try {
    await rpc('get_balance', { account_index: 0, asset_type: 'ZYS' });
    return true;
  } catch { return false; }
}

module.exports = { createAddress, getIncomingTransfers, getZysRate, testConnection };
