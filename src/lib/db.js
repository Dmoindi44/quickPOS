import { supabase } from "./supabase";

const hashPIN = async (pin) => {
  const data = new TextEncoder().encode(pin + "qpos_v2_salt");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
};

/* Auth */
export const signIn = async (email, password) => {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
};
export const signUp = async (email, password) => {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
};
export const signOut = async () => { await supabase.auth.signOut(); };
export const getUser = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
};

/* Shop */
export const getShopBySlug = async (slug) => {
  const { data, error } = await supabase
    .from("shops").select("id,name,slug,pin_hash,staff_pin_hash")
    .eq("slug", slug).single();
  if (error) throw error;
  return data;
};
export const getShopByOwner = async (userId) => {
  const { data, error } = await supabase
    .from("shops").select("*").eq("owner_id", userId).single();
  if (error && error.code !== "PGRST116") throw error;
  return data;
};
export const createShop = async (name, ownerPin) => {
  const user = await getUser();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const pin_hash = await hashPIN(ownerPin);
  const { data, error } = await supabase
    .from("shops").insert({ owner_id: user.id, name, slug, pin_hash }).select().single();
  if (error) throw error;
  return data;
};
export const updateShop = async (id, updates) => {
  if (updates.ownerPin) { updates.pin_hash = await hashPIN(updates.ownerPin); delete updates.ownerPin; }
  if (updates.staffPin) { updates.staff_pin_hash = await hashPIN(updates.staffPin); delete updates.staffPin; }
  const { data, error } = await supabase.from("shops").update(updates).eq("id", id).select().single();
  if (error) throw error;
  return data;
};
export const verifyOwnerPIN = async (shop, pin) => {
  const hashed = await hashPIN(pin);
  return hashed === shop.pin_hash;
};
export const verifyStaffPIN = async (shop, pin) => {
  const hashed = await hashPIN(pin);
  return hashed === shop.staff_pin_hash;
};

/* Products */
export const getProducts = async (shopId) => {
  const { data, error } = await supabase.from("products").select("*").eq("shop_id", shopId).order("name");
  if (error) throw error;
  return data || [];
};
export const addProduct = async (shopId, product) => {
  const { data, error } = await supabase.from("products").insert({ ...product, shop_id: shopId }).select().single();
  if (error) throw error;
  return data;
};
export const updateProduct = async (id, updates) => {
  const { data, error } = await supabase.from("products").update(updates).eq("id", id).select().single();
  if (error) throw error;
  return data;
};
export const deleteProduct = async (id) => {
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) throw error;
};

/* Sales */
export const getSales = async (shopId, from, to) => {
  let query = supabase.from("sales").select("*").eq("shop_id", shopId).order("ts", { ascending: false });
  if (from) query = query.gte("ts", from);
  if (to)   query = query.lte("ts", to);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};
export const addSale = async (shopId, sale) => {
  const { data, error } = await supabase.from("sales").insert({ ...sale, shop_id: shopId }).select().single();
  if (error) throw error;
  return data;
};

/* Expenses */
export const getExpenses = async (shopId, from, to) => {
  let query = supabase.from("expenses").select("*").eq("shop_id", shopId).order("ts", { ascending: false });
  if (from) query = query.gte("ts", from);
  if (to)   query = query.lte("ts", to);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};
export const addExpense = async (shopId, expense) => {
  const { data, error } = await supabase.from("expenses").insert({ ...expense, shop_id: shopId }).select().single();
  if (error) throw error;
  return data;
};
export const deleteExpense = async (id) => {
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) throw error;
};

/* Atomic stock decrement — prevents race conditions */
export const decrementStock = async (productId, qty) => {
  const { error } = await supabase.rpc("decrement_stock", {
    product_id: productId,
    qty,
  });
  if (error) throw error;
};
