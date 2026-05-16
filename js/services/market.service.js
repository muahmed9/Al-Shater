import { sb }     from '../core/supabase.js';
import { Config }  from '../core/config.js';
import { sanitize } from '../core/utils.js';

const T = Config.TABLES;

export async function fetchActiveProducts() {
  const { data, error } = await sb.from(T.MARKET_PRODUCTS).select('*').eq('active', true).gt('stock', 0).order('name');
  if (error) throw error;
  return data ?? [];
}

export async function fetchAllProducts() {
  const { data, error } = await sb.from(T.MARKET_PRODUCTS).select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function saveProduct(product) {
  const price    = Number(product.price) || 0;
  const discount = Number(product.discount) || 0;
  const payload = {
    name:            sanitize(product.name, 80),
    price:           price,
    discount:        discount,
    effective_price: discount > 0 ? Math.max(0, price - discount) : price,
    stock:           Number(product.stock)    || 0,
    unit:            sanitize(product.unit, 20) || 'قطعة',
    category:        product.category        || 'other',
    description:     sanitize(product.description, 200),
    image_url:       product.image_url        || null,
    active:          product.active           ?? true,
    is_suggested:    product.is_suggested     ?? false,
    min_stock:       Number(product.min_stock) || 0,
  };
  if (product.id) {
    const { error } = await sb.from(T.MARKET_PRODUCTS).update(payload).eq('id', product.id);
    if (error) throw error;
    return product.id;
  } else {
    const { data, error } = await sb.from(T.MARKET_PRODUCTS).insert(payload).select('id').single();
    if (error) throw error;
    return data.id;
  }
}

export async function deleteProduct(id) {
  const { error } = await sb.from(T.MARKET_PRODUCTS).delete().eq('id', id);
  if (error) throw error;
}

export async function adjustProductStock(id, type, qty) {
  const { data: prod, error: fetchErr } = await sb.from(T.MARKET_PRODUCTS).select('stock').eq('id', id).single();
  if (fetchErr) throw fetchErr;
  let newStock;
  if (type === 'set')      newStock = Number(qty);
  else if (type === 'add') newStock = prod.stock + Number(qty);
  else                     newStock = Math.max(0, prod.stock - Number(qty));
  const { error } = await sb.from(T.MARKET_PRODUCTS).update({ stock: newStock }).eq('id', id);
  if (error) throw error;
}

export async function fetchSupplies() {
  const { data, error } = await sb.from(T.SUPPLIES).select('*').order('name');
  if (error) throw error;
  return data ?? [];
}

export async function saveSupply(supply) {
  const payload = {
    name:          sanitize(supply.name, 80),
    category:      supply.category  || 'other',
    unit:          sanitize(supply.unit, 20) || 'قطعة',
    stock:         Number(supply.stock)      || 0,
    min_stock:     Number(supply.min_stock)  || 0,
    cost_per_unit: Number(supply.cost_per_unit) || 0,
    notes:         sanitize(supply.notes, 200),
  };
  if (supply.id) {
    const { error } = await sb.from(T.SUPPLIES).update(payload).eq('id', supply.id);
    if (error) throw error;
  } else {
    const { error } = await sb.from(T.SUPPLIES).insert(payload);
    if (error) throw error;
  }
}

export async function adjustSupplyStock(id, type, qty, note = '') {
  const { data: sup, error: fetchErr } = await sb.from(T.SUPPLIES).select('stock').eq('id', id).single();
  if (fetchErr) throw fetchErr;
  const delta    = type === 'add' ? Number(qty) : -Number(qty);
  const newStock = Math.max(0, sup.stock + delta);
  const { error } = await sb.from(T.SUPPLIES).update({ stock: newStock }).eq('id', id);
  if (error) throw error;
  await sb.from(T.SUPPLY_LOG).insert({ supply_id: id, type, qty: Number(qty), note: sanitize(note, 200) }).catch(() => {});
}

export async function fetchSupplyLog(supplyId) {
  const { data, error } = await sb.from(T.SUPPLY_LOG).select('*').eq('supply_id', supplyId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function loadPricing() {
  const { data } = await sb.from(T.SETTINGS).select('value').eq('key', 'pricing').maybeSingle();
  if (!data?.value) return null;
  return { ...Config.DEFAULT_PRICING, ...data.value };
}

export async function savePricing(pricing) {
  const { error } = await sb.from(T.SETTINGS).upsert({ key: 'pricing', value: pricing }, { onConflict: 'key' });
  if (error) throw error;
}
