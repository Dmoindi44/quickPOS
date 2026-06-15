import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import {
  signIn, signUp, signOut, getUser,
  getShopByOwner, getShopBySlug, createShop, updateShop,
  verifyOwnerPIN, verifyStaffPIN,
  getProducts, addProduct, updateProduct, deleteProduct, decrementStock,
  getSales, addSale,
  getExpenses, addExpense, deleteExpense, resetPassword,
} from "./lib/db";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/* ── Constants ── */

/* ── Image Compression ── */
const compressImage = (file, maxWidth=800, quality=0.75) => new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const scale  = Math.min(1, maxWidth / img.width);
      canvas.width  = img.width  * scale;
      canvas.height = img.height * scale;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(new File([blob], file.name, { type:"image/jpeg" })), "image/jpeg", quality);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

/* ── Offline Sale Queue ── */
const QUEUE_KEY = "quickpos_offline_queue";

const getQueue = () => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch { return []; }
};

const addToQueue = (sale) => {
  const queue = getQueue();
  queue.push({ ...sale, _queued_at: Date.now(), _id: Math.random().toString(36).slice(2) });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
};

const removeFromQueue = (id) => {
  const queue = getQueue().filter(s => s._id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
};


/* ── Bluetooth / ESC-POS ── */
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const BT_SERVICE  = "000018f0-0000-1000-8000-00805f9b34fb";
const BT_CHAR     = "00002af1-0000-1000-8000-00805f9b34fb";

const escPos = (lines) => {
  const ESC=0x1b, GS=0x1d;
  const cmds = [];
  const push = (...bytes) => bytes.forEach(b=>cmds.push(b));
  const text  = (str) => str.split("").forEach(c=>cmds.push(c.charCodeAt(0)));
  push(ESC,0x40);
  push(ESC,0x61,0x01);
  push(ESC,0x45,0x01);
  text("QUICKPOS RECEIPT"); push(0x0a);
  push(ESC,0x45,0x00);
  push(ESC,0x61,0x00);
  text("--------------------------------"); push(0x0a);
  lines.forEach(l=>{ text(l); push(0x0a); });
  text("--------------------------------"); push(0x0a);
  push(GS,0x56,0x41,0x10);
  return new Uint8Array(cmds);
};

const formatReceiptLines = (sale, shopName) => {
  const date = new Date().toLocaleString("en-KE",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
  const lines = [date,""];
  sale.items.forEach(i=>{
    const name = (i.name+(i.unit?" "+i.unit:"")).substring(0,20);
    const qty  = "x"+i.qty;
    const amt  = "KSh "+Math.round(i.price*i.qty).toLocaleString();
    lines.push(name);
    lines.push("  "+qty+" @ KSh"+Math.round(i.price).toLocaleString()+"   "+amt);
  });
  lines.push("");
  lines.push("TOTAL: KSh "+Math.round(sale.total).toLocaleString());
  lines.push(sale.method==="cash"?"Payment: Cash":"Payment: M-Pesa");
  if(sale.method==="cash"&&sale.change>0) lines.push("Change: KSh "+Math.round(sale.change).toLocaleString());
  lines.push("");
  lines.push("Thank you, "+shopName+"!");
  lines.push("");
  lines.push("Powered by QuickPOS");
  lines.push("0707091803");
  return lines;
};

const printViaBluetooth = async (sale, shopName) => {
  if(isIOS()) throw new Error("ios");
  if(!navigator.bluetooth) throw new Error("nobluetooth");
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices:true,
    optionalServices:[BT_SERVICE],
  });
  const server  = await device.gatt.connect();
  const service = await server.getPrimaryService(BT_SERVICE);
  const char    = await service.getCharacteristic(BT_CHAR);
  const lines   = formatReceiptLines(sale, shopName);
  const data    = escPos(lines);
  for(let i=0;i<data.length;i+=20){
    await char.writeValue(data.slice(i,i+20));
  }
  device.gatt.disconnect();
};


// Categories are now per-shop, loaded from Supabase
const DEFAULT_CATEGORIES = ["Drinks","Snacks","Dairy","Bakery","Produce","Other"];
const fmt   = (n) => `KSh ${Math.round(+n).toLocaleString()}`;
const fmtDt = (iso) => new Date(iso).toLocaleString("en-KE", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
const S     = { fontFamily:"'DM Sans',system-ui,sans-serif" };

/* ══════════════════════════════════════════════════════════════════
   ROOT APP
══════════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen,  setScreen ] = useState("splash"); // splash|login|setup|pin|app
  const [role,    setRole   ] = useState(null);      // owner|staff
  const [shop,    setShop   ] = useState(null);
  const [user,    setUser   ] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let initialized = false;

    const init = async () => {
      // Check if this is a password recovery redirect
      const hash = window.location.hash;
      if (hash && hash.includes("type=recovery")) {
        setScreen("resetpassword");
        setLoading(false);
        initialized = true;
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        setUser(session.user);
        const s = await getShopByOwner(session.user.id);
        if (s) { setShop(s); setScreen("pin"); }
        else setScreen("setup");
      } else {
        setScreen("login");
      }
      setLoading(false);
      initialized = true;
    };
    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_e, session) => {
      // Ignore the initial auth state change — handled by init()
      if (!initialized) return;
      if (_e === "PASSWORD_RECOVERY") {
        setScreen("resetpassword");
        return;
      }
      if (_e === "SIGNED_OUT") {
        setUser(null); setShop(null); setRole(null); setScreen("login");
        return;
      }
      if (_e === "SIGNED_IN" || _e === "TOKEN_REFRESHED") {
        if (session) {
          setUser(session.user);
          const s = await getShopByOwner(session.user.id);
          if (s) { setShop(s); setScreen("pin"); }
          else setScreen("setup");
        }
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const onSetupDone = (s) => { setShop(s); setScreen("pin"); };
  const onPINSuccess = (r) => { setRole(r); setScreen("app"); };
  const onLock = async () => {
    setRole(null);
    // Re-fetch shop to get latest staff_pin_hash and other updates
    const s = await getShopByOwner(user.id);
    if (s) setShop(s);
    setScreen("pin");
  };
  const onShopUpdate = (s) => { setShop(s); };

  if (loading) return <Splash />;
  if (screen === "login")  return <LoginScreen />;
  if (screen === "setup")  return <SetupScreen onDone={onSetupDone} />;
  if (screen === "pin")    return <PINScreen shop={shop} onSuccess={onPINSuccess} />;
  if (screen === "resetpassword") return <ResetPasswordScreen onDone={()=>setScreen("login")} />;
  if (screen === "app")    return <POSApp shop={shop} role={role} user={user} onLock={onLock} onShopUpdate={onShopUpdate} />;
  return <Splash />;
}

/* ── Splash ── */
function Splash() {
  return (
    <div style={{
      minHeight:"100vh",
      minHeight:"100dvh",
      background:"url(/bg.jpg) center/cover no-repeat fixed #0f172a",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      paddingTop:"env(safe-area-inset-top)",
      paddingBottom:"env(safe-area-inset-bottom)",
      animation:"fadeIn 0.3s ease",
      ...S
    }}>
      <style>{`@keyframes fadeIn{from{opacity:0}to{opacity:1}}`}</style>
      <img src="/icons/icon-192.png" alt="QuickPOS" style={{width:"88px", height:"88px", borderRadius:"28px", marginBottom:"20px", boxShadow:"0 8px 32px rgba(79,70,229,0.45)"}} />
      <h1 style={{color:"#f1f5f9", fontSize:"32px", fontWeight:"800", margin:"0 0 6px", letterSpacing:"-0.5px"}}>QuickPOS</h1>
      <p style={{color:"#818cf8", fontSize:"11px", fontWeight:"700", letterSpacing:"3px", textTransform:"uppercase", margin:"0"}}>Freedom From Paperwork</p>
      <div style={{marginTop:"48px", width:"32px", height:"32px", border:"3px solid #4f46e5", borderTopColor:"transparent", borderRadius:"50%", animation:"spin 0.8s linear infinite"}} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   LOGIN SCREEN
══════════════════════════════════════════════════════════════════ */
function LoginScreen() {
  const [mode,     setMode    ] = useState("login"); // login|register|reset
  const [email,    setEmail   ] = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError   ] = useState("");
  const [loading,  setLoading ] = useState(false);

  const handle = async () => {
    setError(""); setLoading(true);
    try {
      if (mode === "login") await signIn(email, password);
      else if (mode === "register") await signUp(email, password);
      else if (mode === "reset") {
        await resetPassword(email);
        setError("✓ Password reset email sent! Check your inbox.");
        setLoading(false);
        return;
      }
    } catch(e) {
      const msg = e.message || "";
      if (msg.toLowerCase().includes("email not confirmed")) {
        setError("Please confirm your email address first. Check your inbox for a confirmation link.");
      } else if (msg.toLowerCase().includes("invalid login credentials")) {
        setError("Incorrect email or password. Please try again.");
      } else if (msg.toLowerCase().includes("user already registered")) {
        setError("An account with this email already exists. Please sign in.");
      } else {
        setError(msg);
      }
    }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh", background:"url(/bg.jpg) center/cover no-repeat fixed #0f172a", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px", ...S}}>
      
      <div style={{width:"100%", maxWidth:"360px"}}>
        <div style={{textAlign:"center", marginBottom:"28px"}}>
          <img src="/icons/icon-192.png" alt="QuickPOS" style={{width:"72px", height:"72px", borderRadius:"20px", margin:"0 auto 14px", display:"block"}} />
          <h1 style={{color:"#f1f5f9", fontSize:"24px", fontWeight:"800", margin:"0 0 3px", letterSpacing:"-0.3px"}}>QuickPOS</h1>
          <p style={{color:"#818cf8", fontSize:"10px", fontWeight:"700", letterSpacing:"2.5px", textTransform:"uppercase", margin:"0 0 6px"}}>Freedom From Paperwork</p>
          <p style={{color:"#64748b", fontSize:"13px", margin:"0"}}>{mode==="login"?"Sign in to your shop":"Create your account"}</p>
        </div>
        <div style={{display:"flex", flexDirection:"column", gap:"12px"}}>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email address"
            style={{background:"#1e293b", border:"1.5px solid #334155", borderRadius:"14px", padding:"14px 16px", color:"#f1f5f9", fontSize:"15px", outline:"none", fontFamily:"inherit"}} />
          {mode!=="reset" && <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password"
            style={{background:"#1e293b", border:"1.5px solid #334155", borderRadius:"14px", padding:"14px 16px", color:"#f1f5f9", fontSize:"15px", outline:"none", fontFamily:"inherit"}}
            onKeyDown={e=>e.key==="Enter"&&handle()} />}
          {error && <p style={{color:"#f87171", fontSize:"12px", margin:"0"}}>{error}</p>}
          <button onClick={handle} disabled={loading || !email || (mode!=="reset" && !password)}
            style={{background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", borderRadius:"14px", padding:"16px", color:"white", fontSize:"16px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit", opacity:loading||!email||(mode!=="reset"&&!password)?0.6:1}}>
            {loading ? "Please wait…" : mode==="login" ? "Sign In" : mode==="register" ? "Create Account" : "Send Reset Email"}
          </button>
          <button onClick={()=>{setMode(m=>m==="login"?"register":"login");setError("");}}
            style={{background:"none", border:"none", color:"#64748b", fontSize:"13px", cursor:"pointer", fontFamily:"inherit"}}>
            {mode==="login" ? "Don't have an account? Register" : mode==="register" ? "Already have an account? Sign in" : "Back to Sign In"}
          </button>
          {mode==="login" && (
            <button onClick={()=>{setMode("reset");setError("");}}
              style={{background:"none", border:"none", color:"#475569", fontSize:"12px", cursor:"pointer", fontFamily:"inherit"}}>
              Forgot password?
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   RESET PASSWORD SCREEN
══════════════════════════════════════════════════════════════════ */
function ResetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm ] = useState("");
  const [error,    setError   ] = useState("");
  const [loading,  setLoading ] = useState(false);
  const [done,     setDone    ] = useState(false);

  const handle = async () => {
    if (password !== confirm) { setError("Passwords don't match"); return; }
    if (password.length < 6)  { setError("Password must be at least 6 characters"); return; }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      setTimeout(onDone, 2000);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh", background:"url(/bg.jpg) center/cover no-repeat fixed #0a0f1e", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px", fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <style>{`@keyframes fadeIn{from{opacity:0}to{opacity:1}}`}</style>
      <div style={{width:"100%", maxWidth:"360px", animation:"fadeIn 0.3s ease"}}>
        <div style={{textAlign:"center", marginBottom:"28px"}}>
          <img src="/icons/icon-192.png" alt="QuickPOS" style={{width:"72px", height:"72px", borderRadius:"20px", margin:"0 auto 14px", display:"block"}} />
          <h1 style={{color:"#f1f5f9", fontSize:"24px", fontWeight:"800", margin:"0 0 3px"}}>Set New Password</h1>
          <p style={{color:"#64748b", fontSize:"13px", margin:0}}>Choose a strong password</p>
        </div>
        {done ? (
          <p style={{color:"#34d399", fontSize:"15px", textAlign:"center", fontWeight:"700"}}>✓ Password updated! Redirecting…</p>
        ) : (
          <div style={{display:"flex", flexDirection:"column", gap:"12px"}}>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="New password"
              style={{background:"rgba(30,41,59,0.8)", border:"1.5px solid #334155", borderRadius:"14px", padding:"14px 16px", color:"#f1f5f9", fontSize:"15px", outline:"none", fontFamily:"inherit"}} />
            <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Confirm password"
              style={{background:"rgba(30,41,59,0.8)", border:"1.5px solid #334155", borderRadius:"14px", padding:"14px 16px", color:"#f1f5f9", fontSize:"15px", outline:"none", fontFamily:"inherit"}}
              onKeyDown={e=>e.key==="Enter"&&handle()} />
            {error && <p style={{color:"#f87171", fontSize:"12px", margin:0}}>{error}</p>}
            <button onClick={handle} disabled={loading||!password||!confirm}
              style={{background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", borderRadius:"14px", padding:"16px", color:"white", fontSize:"16px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit", opacity:loading||!password||!confirm?0.6:1}}>
              {loading?"Updating…":"Update Password"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   SETUP SCREEN
══════════════════════════════════════════════════════════════════ */
function SetupScreen({ onDone }) {
  const [step,     setStep    ] = useState("shop");
  const [shopName, setShopName] = useState("");
  const [pin1,     setPin1    ] = useState("");
  const [pin2,     setPin2    ] = useState("");
  const [error,    setError   ] = useState("");
  const [saving,   setSaving  ] = useState(false);

  const handlePinKey = (k, current, setter, next) => {
    setError("");
    if (k==="⌫") { setter(p=>p.slice(0,-1)); return; }
    const val = current + k; setter(val);
    if (val.length===4) setTimeout(()=>next(), 200);
  };

  const handleConfirmKey = async (k) => {
    setError("");
    if (k==="⌫") { setPin2(p=>p.slice(0,-1)); return; }
    const val = pin2 + k; setPin2(val);
    if (val.length===4) {
      if (val !== pin1) { setError("PINs don't match"); setPin1(""); setPin2(""); setStep("pin"); return; }
      setSaving(true);
      try {
        const shop = await createShop(shopName.trim(), val);
        onDone(shop);
      } catch(e) { setError(e.message); setSaving(false); }
    }
  };

  return (
    <div style={{minHeight:"100vh", background:"url(/bg.jpg) center/cover no-repeat fixed #0f172a", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px", ...S}}>
      
      <div style={{width:"100%", maxWidth:"360px"}}>
        <div style={{textAlign:"center", marginBottom:"28px"}}>
          <img src="/icons/icon-192.png" alt="QuickPOS" style={{width:"72px", height:"72px", borderRadius:"20px", margin:"0 auto 14px", display:"block"}} />
          <h1 style={{color:"#f1f5f9", fontSize:"24px", fontWeight:"800", margin:"0 0 3px"}}>QuickPOS</h1>
          <p style={{color:"#818cf8", fontSize:"10px", fontWeight:"700", letterSpacing:"2.5px", textTransform:"uppercase", margin:"0 0 6px"}}>Freedom From Paperwork</p>
          <p style={{color:"#64748b", fontSize:"13px", margin:"0"}}>
            {step==="shop"?"Enter your shop name":step==="pin"?"Create owner PIN":"Confirm owner PIN"}
          </p>
        </div>

        {step==="shop" && (
          <div style={{display:"flex", flexDirection:"column", gap:"12px"}}>
            <input type="text" value={shopName} onChange={e=>setShopName(e.target.value)} placeholder="e.g. Mama Grace Shop"
              style={{background:"#1e293b", border:"1.5px solid #334155", borderRadius:"14px", padding:"14px 16px", color:"#f1f5f9", fontSize:"15px", outline:"none", fontFamily:"inherit"}} />
            {error && <p style={{color:"#f87171", fontSize:"12px"}}>{error}</p>}
            <button onClick={()=>{ if(!shopName.trim()){setError("Enter shop name");return;} setStep("pin"); }}
              style={{background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", borderRadius:"14px", padding:"16px", color:"white", fontSize:"16px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
              Continue →
            </button>
          </div>
        )}
        {step==="pin" && <PINPad pin={pin1} onKey={(k)=>handlePinKey(k,pin1,setPin1,()=>setStep("confirm"))} error={error} color="#4f46e5" />}
        {step==="confirm" && <PINPad pin={pin2} onKey={handleConfirmKey} error={error} color="#4f46e5" saving={saving} />}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   PIN SCREEN — owner or staff login
══════════════════════════════════════════════════════════════════ */
function PINScreen({ shop, onSuccess }) {
  const [mode,    setMode   ] = useState("choose"); // choose|owner|staff
  const [pin,     setPin    ] = useState("");
  const [error,   setError  ] = useState("");
  const [shaking, setShaking] = useState(false);

  const shake = (msg) => {
    setShaking(true);
    setTimeout(()=>{ setShaking(false); setPin(""); setError(msg); }, 500);
  };

  const handleKey = async (k) => {
    setError("");
    if (k==="⌫") { setPin(p=>p.slice(0,-1)); return; }
    const next = pin + k; setPin(next);
    if (next.length===4) {
      if (mode==="owner") {
        const ok = await verifyOwnerPIN(shop, next);
        if (ok) onSuccess("owner"); else shake("Wrong PIN");
      } else {
        const ok = await verifyStaffPIN(shop, next);
        if (ok) onSuccess("staff"); else shake("Wrong PIN");
      }
    }
  };

  if (mode==="choose") return (
    <div style={{minHeight:"100vh", background:"url(/bg.jpg) center/cover no-repeat fixed #0f172a", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px", ...S}}>
      
      <img src="/icons/icon-192.png" alt="QuickPOS" style={{width:"72px", height:"72px", borderRadius:"20px", marginBottom:"16px"}} />
      <h1 style={{color:"#f1f5f9", fontSize:"22px", fontWeight:"800", margin:"0 0 2px"}}>{shop.name}</h1>
      <p style={{color:"#818cf8", fontSize:"10px", fontWeight:"700", letterSpacing:"2.5px", textTransform:"uppercase", margin:"0 0 4px"}}>Freedom From Paperwork</p>
      <p style={{color:"#64748b", fontSize:"13px", margin:"0 0 32px"}}>Who are you?</p>
      <div style={{display:"flex", flexDirection:"column", gap:"12px", width:"100%", maxWidth:"280px"}}>
        <button onClick={()=>setMode("owner")}
          style={{background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", borderRadius:"16px", padding:"18px", color:"white", fontSize:"16px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
          👤 Owner
        </button>
        {shop.staff_pin_hash && (
          <button onClick={()=>setMode("staff")}
            style={{background:"#1e293b", border:"1.5px solid #334155", borderRadius:"16px", padding:"18px", color:"#e2e8f0", fontSize:"16px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
            🧑‍💼 Staff
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{minHeight:"100vh", background:"url(/bg.jpg) center/cover no-repeat fixed #0f172a", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px", ...S}}>
      
      <p style={{color:"#f1f5f9", fontSize:"18px", fontWeight:"700", margin:"0 0 4px"}}>{mode==="owner"?"👤 Owner":"🧑‍💼 Staff"}</p>
      <p style={{color:"#64748b", fontSize:"13px", margin:"0 0 24px"}}>Enter your PIN</p>
      <PINPad pin={pin} onKey={handleKey} error={error} shaking={shaking} color={mode==="owner"?"#4f46e5":"#059669"} />
      <button onClick={()=>{setMode("choose");setPin("");setError("");}}
        style={{background:"none", border:"none", color:"#64748b", fontSize:"13px", cursor:"pointer", fontFamily:"inherit", marginTop:"16px"}}>
        ← Back
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   PIN PAD
══════════════════════════════════════════════════════════════════ */
function PINPad({ pin, onKey, error, shaking, color="#4f46e5", saving=false }) {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  return (
    <div style={{width:"100%", maxWidth:"280px"}}>
      <div style={{display:"flex", justifyContent:"center", gap:"12px", marginBottom:"24px", transform:shaking?"translateX(8px)":"none", transition:"transform 0.1s"}}>
        {[0,1,2,3].map(i=>(
          <div key={i} style={{width:"16px", height:"16px", borderRadius:"50%", background:i<pin.length?color:"#334155", transition:"background 0.15s"}} />
        ))}
      </div>
      {error && <p style={{color:"#f87171", fontSize:"12px", textAlign:"center", marginBottom:"12px"}}>{error}</p>}
      {saving && <p style={{color:"#818cf8", fontSize:"12px", textAlign:"center", marginBottom:"12px"}}>Setting up…</p>}
      <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"10px"}}>
        {keys.map((k,i)=>(
          <button key={i} onClick={()=>k&&onKey(k)} disabled={!k}
            style={{padding:"18px", borderRadius:"14px", background:k?"#1e293b":"transparent", border:k?"1px solid #334155":"none",
              color:"#e2e8f0", fontSize:k==="⌫"?"20px":"22px", fontWeight:"600", cursor:k?"pointer":"default", fontFamily:"inherit", transition:"background 0.15s"}}
            onTouchStart={e=>k&&(e.currentTarget.style.background="#334155")}
            onTouchEnd={e=>k&&(e.currentTarget.style.background="#1e293b")}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════════════ */
function Toast({ message, type="ok" }) {
  if (!message) return null;
  return (
    <div style={{position:"fixed", bottom:"90px", left:"50%", transform:"translateX(-50%)", background:type==="err"?"#7f1d1d":"#1e3a5f",
      color:type==="err"?"#fca5a5":"#93c5fd", padding:"10px 20px", borderRadius:"100px", fontSize:"13px", fontWeight:"600",
      zIndex:300, pointerEvents:"none", whiteSpace:"nowrap", ...S}}>
      {message}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   MAIN POS APP
══════════════════════════════════════════════════════════════════ */
function POSApp({ shop, role, user, onLock, onShopUpdate }) {
  const [products,  setProducts ] = useState([]);
  const [sales,     setSales    ] = useState([]);
  const [expenses,  setExpenses ] = useState([]);
  const [cart,      setCart     ] = useState([]);
  const [view,      setView     ] = useState("pos");
  const [overlay,   setOverlay  ] = useState(null);
  const [toast,     setToast    ] = useState({ msg:"", type:"ok" });
  const [loading,    setLoading   ] = useState(true);
  const [categories, setCategories] = useState(shop.categories || DEFAULT_CATEGORIES);
  const [lastSale,   setLastSale  ] = useState(null);
  const [isOnline,   setIsOnline  ] = useState(navigator.onLine);
  const [queueCount, setQueueCount] = useState(getQueue().length);

  // Sync offline queue when connection returns
  useEffect(() => {
    const syncQueue = async () => {
      const queue = getQueue();
      if (queue.length === 0) return;
      showToast(`Syncing ${queue.length} offline sale(s)…`);
      for (const sale of queue) {
        try {
          const { _queued_at, _id, ...saleData } = sale;
          await addSale(shop.id, saleData);
          removeFromQueue(_id);
          setQueueCount(getQueue().length);
        } catch(e) {
          console.error("Sync failed for sale:", e);
        }
      }
      const remaining = getQueue().length;
      if (remaining === 0) showToast("All offline sales synced ✓");
      else showToast(`${remaining} sale(s) failed to sync`, "err");
    };

    const handleOnline  = () => { setIsOnline(true);  syncQueue(); };
    const handleOffline = () => { setIsOnline(false); showToast("You are offline — sales will be saved locally", "err"); };

    window.addEventListener("online",  handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online",  handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [shop.id]);

  const showToast = (msg, type="ok") => {
    setToast({ msg, type });
    setTimeout(()=>setToast({ msg:"", type:"ok" }), 2500);
  };

  useEffect(()=>{
    const load = async () => {
      const [p, s, e] = await Promise.all([
        getProducts(shop.id),
        getSales(shop.id),
        getExpenses(shop.id),
      ]);
      setProducts(p); setSales(s); setExpenses(e);
      setLoading(false);
    };
    load();
  }, [shop.id]);

  const handleAddToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(i=>i.pid===product.id);
      if (existing) return prev.map(i=>i.pid===product.id?{...i,qty:i.qty+1}:i);
      return [...prev, { pid:product.id, name:product.name, price:product.price, photo_url:product.photo_url, qty:1, unit:product.unit||"", fractional:product.fractional||false }];
    });
  };



  const handleCheckout = async (method, tendered) => {
    const total = cart.reduce((s,i)=>s+i.price*i.qty, 0);
    const sale = { items: cart, total, subtotal: total, tax: 0, method, tendered: tendered||0, change: tendered?tendered-total:0 };
    const cartSnapshot = [...cart];

    // Update local UI immediately
    for (const item of cartSnapshot) {
      setProducts(prev=>prev.map(pp=>pp.id===item.pid?{...pp,stock:Math.max(0,pp.stock-item.qty)}:pp));
    }
    setCart([]);
    setLastSale({ ...sale, items: cartSnapshot });

    try {
      const saved = await Promise.race([
        addSale(shop.id, sale),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("timeout")),5000))
      ]);
      setSales(prev=>[saved,...prev]);
      for (const item of cartSnapshot) {
        try {
          const stockId = item.productId || item.pid;
          const deductQty = item.isContainer ? item.weight * item.qty : item.qty;
          await decrementStock(stockId, deductQty);
        } catch(_) {}
      }
      showToast(`Sale saved — ${fmt(total)}`);
    } catch(e) {
      addToQueue({ ...sale, shop_id: shop.id, items: cartSnapshot });
      setQueueCount(getQueue().length);
      showToast("Offline — sale queued for sync", "err");
    }
  };

  const shareWhatsApp = (sale) => {
    const lines = sale.items.map(i =>
      `${i.name}${i.unit?" "+i.unit:""} x${i.qty}   KSh ${Math.round(i.price*i.qty).toLocaleString()}`
    ).join("\n");
    const method = sale.method==="cash" ? "💵 Cash" : "💳 M-Pesa";
    const date = new Date().toLocaleString("en-KE",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const msg = [
      "🧾 *QuickPOS Receipt*",
      `📅 ${date}`,
      "━━━━━━━━━━━━━━",
      lines,
      "━━━━━━━━━━━━━━",
      `*TOTAL: KSh ${Math.round(sale.total).toLocaleString()}*`,
      method,
      ...(sale.method==="cash"&&sale.change>0?[`Change: KSh ${Math.round(sale.change).toLocaleString()}`]:[]),
      "━━━━━━━━━━━━━━",
      `Thank you for shopping at ${shop.name}!`,
      "",
      "_Powered by QuickPOS (0707091803)_",
    ].join("\n");
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
  };

  const handleAddProduct = async (form, photoFile) => {
    let photo_url = null;
    if (photoFile) {
      const compressed = await compressImage(photoFile);
      const ext  = "jpg";
      const path = `${shop.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("product-images")
        .upload(path, compressed, { upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage
        .from("product-images")
        .getPublicUrl(path);
      photo_url = urlData.publicUrl;
    }
    const p = await addProduct(shop.id, { ...form, photo_url });
    setProducts(prev=>[...prev, p]);
    setOverlay(null);
    document.body.classList.remove("checkout-open");
    showToast("Product added");
  };

  const handleDeleteProduct = async (id) => {
    await deleteProduct(id);
    setProducts(prev=>prev.filter(p=>p.id!==id));
    showToast("Product deleted");
  };

  const handleAddExpense = async (label, amount) => {
    const e = await addExpense(shop.id, { note: label, amount, category: "General" });
    setExpenses(prev=>[e,...prev]);
    showToast("Expense added");
  };

  const handleDeleteExpense = async (id) => {
    await deleteExpense(id);
    setExpenses(prev=>prev.filter(e=>e.id!==id));
    showToast("Expense deleted");
  };

  const todaySales = sales.filter(s=>new Date(s.ts).toDateString()===new Date().toDateString());
  const todayRev   = todaySales.reduce((s,x)=>s+x.total, 0);
  const lowStock   = products.filter(p=>p.stock>0&&p.stock<=(p.threshold||5));

  if (loading) return <Splash />;

  return (
    /* Outer shell: full viewport, dark bg visible on wide screens */
    <div style={{minHeight:"100dvh", background:"url(/bg.jpg) center/cover no-repeat fixed #0a0f1e", display:"flex", alignItems:"stretch", justifyContent:"center", ...S}}>
    <div style={{width:"100%", maxWidth:"100%", height:"100dvh", display:"flex", flexDirection:"column", background:"transparent", color:"#f1f5f9", position:"relative"}}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .mono { font-variant-numeric: tabular-nums; }
        button { -webkit-tap-highlight-color: transparent; }
        @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        .screen-fade{animation:fadeIn 0.25s ease;}
        button { min-height: 36px; }
        /* Desktop: 3 column product grid */
        @media (min-width: 768px) { .product-grid { grid-template-columns: repeat(4,1fr) !important; } }
        @media (min-width: 1200px) { .product-grid { grid-template-columns: repeat(6,1fr) !important; } }
      `}</style>
      <Toast message={toast.msg} type={toast.type} />

      {/* Header */}
      <div style={{background:"rgba(10,15,30,0.75)", borderBottom:"1px solid rgba(255,255,255,0.08)", padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0}}>
        <div>
          <p style={{fontSize:"16px", fontWeight:"800", color:"#f1f5f9"}}>{shop.name}</p>
          <p style={{fontSize:"11px", color:role==="owner"?"#818cf8":"#34d399", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px"}}>
            {role==="owner"?"👤 Owner":"🧑‍💼 Staff"}
          </p>
          {!isOnline && <p style={{fontSize:"10px", color:"#f87171", fontWeight:"700"}}>● OFFLINE</p>}
          {queueCount>0 && isOnline && <p style={{fontSize:"10px", color:"#fbbf24", fontWeight:"700"}}>⏳ {queueCount} pending</p>}
        </div>
        <div style={{display:"flex", gap:"8px", alignItems:"center"}}>
          {role==="owner" && lowStock.length>0 && (
            <button onClick={()=>setView("inventory")} style={{background:"rgba(245,158,11,0.2)", color:"#fbbf24", border:"none", borderRadius:"100px", padding:"4px 10px", fontSize:"11px", fontWeight:"600", cursor:"pointer", fontFamily:"inherit"}}>
              ⚠ {lowStock.length}
            </button>
          )}
          <button onClick={onLock} style={{background:"#1e293b", border:"none", borderRadius:"10px", padding:"8px 12px", color:"#64748b", fontSize:"12px", fontWeight:"600", cursor:"pointer", fontFamily:"inherit"}}>
            🔒 Lock
          </button>
        </div>
      </div>

      {/* Main content */}
      <main style={{flex:1, overflow:"hidden", display:"flex", flexDirection:"column"}}>
        {view==="pos"       && <POSView products={products} cart={cart} setCart={setCart} onAddToCart={handleAddToCart} onCheckout={handleCheckout} showToast={showToast} categories={categories} lastSale={lastSale} onShareWhatsApp={shareWhatsApp} shop={shop} />}
        {view==="inventory" && role==="owner" && <InventoryView products={products} setProducts={setProducts} onAdd={()=>{setOverlay("addProduct");document.body.classList.add("checkout-open");}} onDelete={handleDeleteProduct} updateProduct={updateProduct} showToast={showToast} categories={categories} />}
        {view==="reports"   && role==="owner" && <ReportsView sales={sales} expenses={expenses} todaySales={todaySales} todayRev={todayRev} shopName={shop.name} onAddExpense={handleAddExpense} onDeleteExpense={handleDeleteExpense} />}
        {view==="settings"  && role==="owner" && <SettingsView shop={shop} onShopUpdate={onShopUpdate} showToast={showToast} onSignOut={()=>{ signOut(); }} categories={categories} setCategories={setCategories} />}
      </main>

      {/* Nav */}
      <nav style={{background:"rgba(10,15,30,0.75)", borderTop:"1px solid rgba(255,255,255,0.08)", display:"flex", padding:"8px 0 20px", flexShrink:0, position:"relative", zIndex:50}}>
        {[
          ["pos","🛒","POS"],
          ...(role==="owner"?[["inventory","📦","Stock"],["reports","📊","Reports"],["settings","⚙️","Settings"]]:[]),
        ].map(([v,icon,label])=>(
          <button key={v} onClick={()=>setView(v)} style={{flex:1, background:"none", border:"none", cursor:"pointer", padding:"6px 0", fontFamily:"inherit",
            display:"flex", flexDirection:"column", alignItems:"center", gap:"2px"}}>
            <span style={{fontSize:"20px"}}>{icon}</span>
            <span style={{fontSize:"10px", fontWeight:"600", color:view===v?"#818cf8":"#475569", textTransform:"uppercase", letterSpacing:"0.5px"}}>{label}</span>
          </button>
        ))}
        {role==="staff" && (
          <button onClick={()=>{setOverlay("addProduct");document.body.classList.add("checkout-open");}} style={{flex:1, background:"none", border:"none", cursor:"pointer", padding:"6px 0", fontFamily:"inherit",
            display:"flex", flexDirection:"column", alignItems:"center", gap:"2px"}}>
            <span style={{fontSize:"20px"}}>＋</span>
            <span style={{fontSize:"10px", fontWeight:"600", color:"#475569", textTransform:"uppercase", letterSpacing:"0.5px"}}>Add</span>
          </button>
        )}
      </nav>

      {overlay==="addProduct" && <AddProductOverlay onSave={handleAddProduct} onClose={()=>{setOverlay(null);document.body.classList.remove("checkout-open");}} categories={categories} />}
    </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   POS VIEW
══════════════════════════════════════════════════════════════════ */
function POSView({ products, cart, setCart, onAddToCart, onCheckout, showToast, categories, lastSale, onShareWhatsApp, shop }) {
  const [search,      setSearch     ] = useState("");
  const [category,    setCategory   ] = useState("All");
  const [checkout,    setCheckout   ] = useState(false);
  const [method,      setMethod     ] = useState("cash");
  const [tendered,    setTendered   ] = useState("");
  const [showReceipt, setShowReceipt] = useState(false);
  const [confirming,  setConfirming ] = useState(false);

  const shopCats = ["All", ...(categories || DEFAULT_CATEGORIES)];
  const filtered = products.filter(p => {
    const matchCat = category==="All" || p.category===category;
    const matchQ   = !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.barcode||"").includes(search);
    return matchCat && matchQ;
  });

  const total     = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  const cartCount = cart.reduce((s,i)=>s+i.qty, 0);
  const change    = parseFloat(tendered) - total;

  const [fracPicker,      setFracPicker     ] = useState(null);
  const [containerPicker, setContainerPicker] = useState(null);

  const addContainerToCart = (product, container) => {
    setCart(prev => {
      const key = `${product.id}_${container.name}`;
      const existing = prev.find(i=>i.pid===key);
      if (existing) return prev.map(i=>i.pid===key?{...i,qty:i.qty+1}:i);
      return [...prev, {
        pid: key,
        productId: product.id,
        name: `${product.name} (${container.name})`,
        price: container.price,
        photo_url: product.photo_url,
        qty: 1,
        unit: container.unit||"kg",
        weight: container.weight,
        fractional: false,
        isContainer: true,
      }];
    });
    setContainerPicker(null);
  };

  const adjust = (pid, delta) => {
    setCart(prev => {
      const updated = prev.map(i=>{
        if (i.pid!==pid) return i;
        if (i.fractional) return i; // fractional uses picker instead
        const newQty = Math.max(0, i.qty + delta);
        return {...i, qty:newQty};
      }).filter(i=>i.qty>0);
      return updated;
    });
  };

  const setFracQty = (pid, qty) => {
    if (qty===0) { setCart(prev=>prev.filter(i=>i.pid!==pid)); }
    else { setCart(prev=>prev.map(i=>i.pid===pid?{...i,qty}:i)); }
    setFracPicker(null);
  };

  const handleCheckout = async () => {
    if (cart.length===0) return;
    if (confirming) return;
    if (method==="cash" && parseFloat(tendered)<total) { showToast("Insufficient amount","err"); return; }
    setConfirming(true);
    try {
      await onCheckout(method, method==="cash"?parseFloat(tendered):0);
      setCheckout(false); setTendered("");
      document.body.classList.remove("checkout-open");
      document.body.classList.add("checkout-open");
      setShowReceipt(true);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div style={{flex:1, overflow:"hidden", display:"flex", flexDirection:"column", height:"100%"}}>
      {/* Search */}
      <div style={{padding:"12px 16px 8px", flexShrink:0}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍  Search products…"
          style={{width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:"12px", padding:"10px 14px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit"}} />
      </div>

      {/* Categories */}
      <div style={{display:"flex", gap:"8px", padding:"0 16px 8px", overflowX:"auto", flexShrink:0}} className="no-scrollbar">
        {shopCats.map(c=>(
          <button key={c} onClick={()=>setCategory(c)}
            style={{flexShrink:0, padding:"6px 14px", borderRadius:"100px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"12px", fontWeight:"600",
              background:category===c?"#4f46e5":"#1e293b", color:category===c?"white":"#64748b"}}>
            {c}
          </button>
        ))}
      </div>

      {/* Products grid */}
      <div style={{flex:1, overflowY:"auto", padding:"0 16px 10px", display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:"10px", alignContent:"start"}} className="no-scrollbar product-grid">
        {filtered.map(p=>(
          <button key={p.id} onClick={()=>p.containers&&p.containers.length>0?setContainerPicker(p):onAddToCart(p)}
            style={{background:"rgba(15,23,42,0.75)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:"16px", padding:"14px 12px", cursor:"pointer", textAlign:"left", fontFamily:"inherit", position:"relative"}}>
            {p.stock===0 && <span style={{position:"absolute", top:"8px", right:"8px", background:"#7f1d1d", color:"#fca5a5", fontSize:"9px", fontWeight:"700", padding:"2px 6px", borderRadius:"100px"}}>OUT</span>}
            {p.photo_url
              ? <img src={p.photo_url} alt={p.name} style={{width:"100%", height:"72px", objectFit:"cover", borderRadius:"10px", marginBottom:"8px"}} />
              : <div style={{fontSize:"28px", marginBottom:"6px"}}>📦</div>
            }
            <p style={{fontSize:"13px", fontWeight:"600", color:"#e2e8f0", marginBottom:"2px", lineHeight:"1.3"}}>{p.name}</p>
            <p style={{fontSize:"14px", fontWeight:"800", color:"#818cf8"}}>{fmt(p.price)}</p>
            <p style={{fontSize:"10px", color:"#475569", marginTop:"2px"}}>Stock: {p.fractional?(+p.stock).toFixed(2):p.stock}{p.unit?" "+p.unit:""}</p>
          </button>
        ))}
      </div>

      {/* Cart bar */}

      {cart.length>0 && (
        <div style={{background:"rgba(15,23,42,0.92)", borderTop:"1px solid rgba(255,255,255,0.08)", padding:"12px 16px", flexShrink:0}}>
          {/* Cart items */}
          <div style={{maxHeight:"120px", overflowY:"auto", marginBottom:"10px"}} className="no-scrollbar">
            {cart.map(item=>(
              <div key={item.pid} style={{marginBottom:"6px"}}>
                <div style={{display:"flex", alignItems:"center", justifyContent:"space-between"}}>
                  <p style={{fontSize:"13px", color:"#cbd5e1", flex:1}}>{item.name}{item.unit?" ("+item.unit+")":""}</p>
                  <div style={{display:"flex", alignItems:"center", gap:"8px"}}>
                    {item.fractional ? (
                      <button onClick={()=>setFracPicker(fracPicker===item.pid?null:item.pid)}
                        style={{background:"#334155", border:"none", borderRadius:"8px", padding:"3px 10px", color:"#f1f5f9", fontSize:"13px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
                        {item.qty}{item.unit?" "+item.unit:""} ▾
                      </button>
                    ) : (
                      <>
                        <button onClick={()=>adjust(item.pid,-1)} style={{width:"24px", height:"24px", background:"#334155", border:"none", borderRadius:"50%", color:"#e2e8f0", cursor:"pointer", fontFamily:"inherit"}}>−</button>
                        <span style={{fontSize:"13px", fontWeight:"700", color:"#f1f5f9", minWidth:"20px", textAlign:"center"}}>{item.qty}</span>
                        <button onClick={()=>adjust(item.pid,1)} style={{width:"24px", height:"24px", background:"#334155", border:"none", borderRadius:"50%", color:"#e2e8f0", cursor:"pointer", fontFamily:"inherit"}}>+</button>
                      </>
                    )}
                    <span style={{fontSize:"13px", fontWeight:"700", color:"#818cf8", minWidth:"60px", textAlign:"right"}}>{fmt(item.price*item.qty)}</span>
                  </div>
                </div>
                {item.fractional && fracPicker===item.pid && (
                  <div style={{display:"flex", flexWrap:"wrap", gap:"6px", marginTop:"6px", padding:"8px", background:"#0f172a", borderRadius:"10px"}}>
                    {[0.25,0.5,0.75,1,2,3,4,5].map(q=>(
                      <button key={q} onClick={()=>setFracQty(item.pid,q)}
                        style={{padding:"5px 10px", borderRadius:"8px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"12px", fontWeight:"700",
                          background:item.qty===q?"#4f46e5":"#334155", color:item.qty===q?"white":"#94a3b8"}}>
                        {q}{item.unit?" "+item.unit:""}
                      </button>
                    ))}
                    <button onClick={()=>setFracQty(item.pid,0)}
                      style={{padding:"5px 10px", borderRadius:"8px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"12px", fontWeight:"700", background:"#7f1d1d", color:"#fca5a5"}}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{display:"flex", alignItems:"center", justifyContent:"space-between"}}>
            <div>
              <p style={{fontSize:"11px", color:"#64748b"}}>Total ({cartCount} items)</p>
              <p style={{fontSize:"20px", fontWeight:"800", color:"#f1f5f9"}}>{fmt(total)}</p>
            </div>
            <button onClick={()=>{setCheckout(true);document.body.classList.add("checkout-open");}}
              style={{background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", borderRadius:"12px", padding:"12px 24px", color:"white", fontSize:"15px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
              Checkout
            </button>
          </div>
        </div>
      )}

      {/* Checkout overlay */}
      {showReceipt && lastSale && (
        <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", display:"flex", alignItems:"flex-end", zIndex:200}}>
          <div style={{background:"rgba(15,23,42,0.92)", borderRadius:"24px 24px 0 0", width:"100%", padding:"20px", maxHeight:"85vh", overflowY:"auto", fontFamily:"inherit"}} className="no-scrollbar">
            <div style={{display:"flex", justifyContent:"center", marginBottom:"16px"}}>
              <div style={{width:"40px", height:"4px", background:"#334155", borderRadius:"2px"}} />
            </div>
            {/* Receipt header */}
            <div style={{textAlign:"center", marginBottom:"16px", paddingBottom:"16px", borderBottom:"1px dashed #334155"}}>
              <p style={{fontSize:"20px", fontWeight:"800", color:"#f1f5f9", margin:"0 0 2px"}}>🧾 Receipt</p>
              <p style={{fontSize:"12px", color:"#64748b", margin:0}}>{new Date().toLocaleString("en-KE",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}</p>
            </div>
            {/* Items */}
            <div style={{marginBottom:"16px"}}>
              {lastSale.items.map((item,i)=>(
                <div key={i} style={{display:"flex", justifyContent:"space-between", marginBottom:"10px"}}>
                  <div>
                    <p style={{fontSize:"14px", color:"#e2e8f0", fontWeight:"600", margin:"0 0 2px"}}>{item.name}</p>
                    <p style={{fontSize:"12px", color:"#64748b", margin:0}}>x{item.qty}{item.unit?" "+item.unit:""} @ {fmt(item.price)}</p>
                  </div>
                  <p style={{fontSize:"14px", fontWeight:"700", color:"#818cf8"}}>{fmt(item.price*item.qty)}</p>
                </div>
              ))}
            </div>
            {/* Total */}
            <div style={{borderTop:"1px dashed #334155", paddingTop:"12px", marginBottom:"16px"}}>
              <div style={{display:"flex", justifyContent:"space-between", marginBottom:"6px"}}>
                <p style={{fontSize:"15px", fontWeight:"800", color:"#f1f5f9"}}>TOTAL</p>
                <p style={{fontSize:"15px", fontWeight:"800", color:"#4f46e5"}}>{fmt(lastSale.total)}</p>
              </div>
              <div style={{display:"flex", justifyContent:"space-between"}}>
                <p style={{fontSize:"12px", color:"#64748b"}}>{lastSale.method==="cash"?"💵 Cash":"💳 M-Pesa"}</p>
                {lastSale.method==="cash"&&lastSale.change>0&&(
                  <p style={{fontSize:"12px", color:"#34d399"}}>Change: {fmt(lastSale.change)}</p>
                )}
              </div>
            </div>
            {/* Footer */}
            <div style={{textAlign:"center", paddingTop:"12px", borderTop:"1px dashed #334155", marginBottom:"16px"}}>
              <p style={{fontSize:"12px", color:"#475569", margin:0}}>Powered by QuickPOS (0707091803)</p>
            </div>
            {/* 3 Buttons */}
            <div style={{display:"flex", gap:"8px"}}>
              <button onClick={async ()=>{
                  if(isIOS()){showToast("Not supported on iPhone. Use Android or PC.","err");return;}
                  if(!navigator.bluetooth){showToast("Use Chrome on Android or PC for printing.","err");return;}
                  try{
                    showToast("Connecting to printer…");
                    await printViaBluetooth(lastSale, shop.name);
                    showToast("Printed successfully");
                  }catch(e){
                    if(e.message==="ios") showToast("Not supported on iPhone","err");
                    else if(e.message==="nobluetooth") showToast("Use Chrome on Android or PC","err");
                    else if(e.name==="NotFoundError") showToast("No printer selected","err");
                    else showToast("Print failed: "+e.message,"err");
                  }
                }}
                style={{flex:1, padding:"13px", borderRadius:"12px", background:"#1e3a5f", border:"none", color:"#93c5fd", fontSize:"13px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit", display:"flex", flexDirection:"column", alignItems:"center", gap:"3px"}}>
                <span style={{fontSize:"18px"}}>🖨️</span>Print
              </button>
              <button onClick={async()=>{
                  const lines = lastSale.items.map(i=>`${i.name} x${i.qty}  KSh ${Math.round(i.price*i.qty).toLocaleString()}`).join("\n");
                  const method = lastSale.method==="cash"?"💵 Cash":"💳 M-Pesa";
                  const date = new Date().toLocaleString("en-KE",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
                  const text = `🧾 Receipt\n📅 ${date}\n━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━\nTOTAL: KSh ${Math.round(lastSale.total).toLocaleString()}\n${method}\n\nPowered by QuickPOS (0707091803)`;
                  if(navigator.share){
                    try{ await navigator.share({ title:"QuickPOS Receipt", text }); }
                    catch(e){ if(e.name!=="AbortError") onShareWhatsApp(lastSale); }
                  } else {
                    onShareWhatsApp(lastSale);
                  }
                }}
                style={{flex:1, padding:"13px", borderRadius:"12px", background:"#14532d", border:"none", color:"#86efac", fontSize:"13px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit", display:"flex", flexDirection:"column", alignItems:"center", gap:"3px"}}>
                <span style={{fontSize:"18px"}}>📲</span>Share
              </button>
              <button onClick={()=>{setShowReceipt(false);document.body.classList.remove("checkout-open");}}
                style={{flex:1, padding:"13px", borderRadius:"12px", background:"#4f46e5", border:"none", color:"white", fontSize:"13px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit", display:"flex", flexDirection:"column", alignItems:"center", gap:"3px"}}>
                <span style={{fontSize:"18px"}}>✓</span>Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Container picker */}
      {containerPicker && (
        <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", display:"flex", alignItems:"flex-end", zIndex:200}}
          onClick={()=>setContainerPicker(null)}>
          <div style={{background:"rgba(15,23,42,0.97)", borderRadius:"24px 24px 0 0", width:"100%", padding:"20px", maxHeight:"70vh", overflowY:"auto", fontFamily:"inherit"}}
            className="no-scrollbar" onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex", justifyContent:"center", marginBottom:"16px"}}>
              <div style={{width:"40px", height:"4px", background:"#334155", borderRadius:"2px"}} />
            </div>
            <div style={{display:"flex", alignItems:"center", gap:"12px", marginBottom:"16px"}}>
              {containerPicker.photo_url
                ? <img src={containerPicker.photo_url} alt={containerPicker.name} style={{width:"48px", height:"48px", objectFit:"cover", borderRadius:"10px"}} />
                : <span style={{fontSize:"32px"}}>📦</span>
              }
              <div>
                <p style={{fontSize:"16px", fontWeight:"800", color:"#f1f5f9", margin:"0 0 2px"}}>{containerPicker.name}</p>
                <p style={{fontSize:"12px", color:"#64748b", margin:0}}>Select container size</p>
              </div>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
              {containerPicker.containers.map((c,i)=>(
                <button key={i} onClick={()=>addContainerToCart(containerPicker, c)}
                  style={{background:"rgba(79,70,229,0.15)", border:"1.5px solid rgba(79,70,229,0.3)", borderRadius:"14px", padding:"14px 16px", cursor:"pointer", fontFamily:"inherit",
                    display:"flex", alignItems:"center", justifyContent:"space-between"}}>
                  <div style={{textAlign:"left"}}>
                    <p style={{fontSize:"15px", fontWeight:"700", color:"#e2e8f0", margin:"0 0 2px"}}>🪣 {c.name}</p>
                    <p style={{fontSize:"12px", color:"#64748b", margin:0}}>{c.weight} {c.unit||"kg"}</p>
                  </div>
                  <p style={{fontSize:"16px", fontWeight:"800", color:"#818cf8", margin:0}}>{fmt(c.price)}</p>
                </button>
              ))}
            </div>
            <button onClick={()=>setContainerPicker(null)}
              style={{width:"100%", marginTop:"16px", padding:"12px", borderRadius:"12px", background:"#334155", border:"none", color:"#94a3b8", fontSize:"14px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {checkout && (
        <div style={{position:"fixed", inset:0, zIndex:300, background:"url(/bg.jpg) center/cover no-repeat fixed #0a0f1e", display:"flex", flexDirection:"column", fontFamily:"'DM Sans',system-ui,sans-serif"}}>
          <div style={{background:"rgba(10,15,30,0.85)", padding:"16px 20px", display:"flex", alignItems:"center", gap:"12px", borderBottom:"1px solid rgba(255,255,255,0.08)", flexShrink:0}}>
            <button onClick={()=>{setCheckout(false);setTendered("");document.body.classList.remove("checkout-open");}}
              style={{background:"rgba(255,255,255,0.1)", border:"none", borderRadius:"10px", padding:"8px 14px", color:"#f1f5f9", fontSize:"14px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
              ← Back
            </button>
            <p style={{fontSize:"18px", fontWeight:"800", color:"#f1f5f9", flex:1, margin:0}}>Checkout</p>
            <p style={{fontSize:"20px", fontWeight:"800", color:"#818cf8", margin:0}}>{fmt(total)}</p>
          </div>
          <div style={{flex:1, overflowY:"auto", padding:"20px"}} className="no-scrollbar">
            <div style={{background:"rgba(15,23,42,0.8)", borderRadius:"16px", padding:"16px", marginBottom:"16px"}}>
              <p style={{fontSize:"12px", fontWeight:"700", color:"#64748b", marginBottom:"12px", textTransform:"uppercase", letterSpacing:"0.5px", margin:"0 0 12px"}}>Order Summary</p>
              {cart.map(item=>(
                <div key={item.pid} style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"10px"}}>
                  <div style={{flex:1}}>
                    <p style={{fontSize:"14px", fontWeight:"600", color:"#e2e8f0", margin:"0 0 2px"}}>{item.name}</p>
                    <p style={{fontSize:"12px", color:"#64748b", margin:0}}>x{item.qty}{item.unit?" "+item.unit:""} @ {fmt(item.price)}</p>
                  </div>
                  <p style={{fontSize:"14px", fontWeight:"700", color:"#818cf8", margin:0}}>{fmt(item.price*item.qty)}</p>
                </div>
              ))}
              <div style={{borderTop:"1px solid rgba(255,255,255,0.08)", paddingTop:"12px", marginTop:"4px", display:"flex", justifyContent:"space-between"}}>
                <p style={{fontSize:"16px", fontWeight:"800", color:"#f1f5f9", margin:0}}>Total</p>
                <p style={{fontSize:"16px", fontWeight:"800", color:"#4f46e5", margin:0}}>{fmt(total)}</p>
              </div>
            </div>
            <p style={{fontSize:"12px", fontWeight:"700", color:"#64748b", marginBottom:"10px", textTransform:"uppercase", letterSpacing:"0.5px"}}>Payment Method</p>
            <div style={{display:"flex", gap:"10px", marginBottom:"16px"}}>
              {[["cash","💵 Cash"],["card","💳 M-Pesa"]].map(([m,label])=>(
                <button key={m} onClick={()=>setMethod(m)}
                  style={{flex:1, padding:"16px", borderRadius:"14px", border:`2px solid ${method===m?"#4f46e5":"rgba(255,255,255,0.1)"}`,
                    background:method===m?"rgba(79,70,229,0.3)":"rgba(15,23,42,0.6)", color:method===m?"#a5b4fc":"#64748b",
                    fontSize:"15px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
                  {label}
                </button>
              ))}
            </div>
            {method==="cash" && (
              <div style={{marginBottom:"16px"}}>
                <p style={{fontSize:"12px", fontWeight:"700", color:"#64748b", marginBottom:"8px", textTransform:"uppercase", letterSpacing:"0.5px"}}>Amount Tendered</p>
                <input type="number" value={tendered} onChange={e=>setTendered(e.target.value)} placeholder="Enter amount"
                  style={{width:"100%", background:"rgba(15,23,42,0.8)", border:"1.5px solid rgba(255,255,255,0.1)", borderRadius:"14px", padding:"16px", color:"#f1f5f9", fontSize:"20px", fontWeight:"700", outline:"none", fontFamily:"inherit"}} />
                {parseFloat(tendered)>=total && (
                  <div style={{background:"rgba(52,211,153,0.15)", borderRadius:"12px", padding:"12px 16px", marginTop:"10px", display:"flex", justifyContent:"space-between"}}>
                    <p style={{color:"#34d399", fontSize:"15px", fontWeight:"700", margin:0}}>Change</p>
                    <p style={{color:"#34d399", fontSize:"15px", fontWeight:"800", margin:0}}>{fmt(change)}</p>
                  </div>
                )}
              </div>
            )}
          </div>
          <div style={{padding:"16px 20px", background:"rgba(10,15,30,0.85)", borderTop:"1px solid rgba(255,255,255,0.08)", flexShrink:0, position:"fixed", bottom:"0", left:"0", right:"0", zIndex:400}}>
            <button onClick={handleCheckout}
              disabled={confirming} style={{width:"100%", padding:"18px", borderRadius:"16px", background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", color:"white", fontSize:"17px", fontWeight:"800", cursor:"pointer", fontFamily:"inherit", opacity:confirming?0.7:1}}>
              {confirming ? "Processing…" : `✓ Confirm Sale — ${fmt(total)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   INVENTORY VIEW
══════════════════════════════════════════════════════════════════ */
function InventoryView({ products, setProducts, onAdd, onDelete, updateProduct: updateProd, showToast, categories }) {
  const [filter,  setFilter  ] = useState("all");
  const [editId,      setEditId     ] = useState(null);
  const [editVal,     setEditVal    ] = useState("");
  const [editProduct, setEditProduct] = useState(null); // full product edit overlay

  const saveStock = async (id, val) => {
    const stock = Math.max(0, parseInt(val)||0);
    await updateProd(id, { stock });
    setProducts(prev=>prev.map(p=>p.id===id?{...p,stock}:p));
    setEditId(null);
    showToast("Stock updated");
  };

  const adjust = async (id, delta) => {
    const p = products.find(p=>p.id===id);
    if (!p) return;
    const stock = Math.max(0, p.stock + delta);
    await updateProd(id, { stock });
    setProducts(prev=>prev.map(pp=>pp.id===id?{...pp,stock}:pp));
  };

  const visible = products.filter(p =>
    filter==="low" ? p.stock>0&&p.stock<=(p.threshold||5) :
    filter==="out" ? p.stock===0 : true
  );
  const lowStk = products.filter(p=>p.stock>0&&p.stock<=(p.threshold||5));
  const outStk = products.filter(p=>p.stock===0);

  return (
    <div style={{flex:1, overflow:"hidden", display:"flex", flexDirection:"column"}}>
      <div style={{padding:"12px 16px 8px", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <p style={{fontSize:"16px", fontWeight:"700"}}>📦 Stock</p>
        <button onClick={onAdd} style={{background:"#4f46e5", border:"none", borderRadius:"10px", padding:"8px 14px", color:"white", fontSize:"13px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>+ Add</button>
      </div>
      {lowStk.length>0 && <p style={{color:"#fbbf24", fontSize:"12px", padding:"0 16px 8px"}}>⚠ {lowStk.length} item(s) running low</p>}
      <div style={{display:"flex", gap:"8px", padding:"0 16px 8px", flexShrink:0}}>
        {[["all","All"],["low","Low Stock"],["out","Out of Stock"]].map(([f,label])=>(
          <button key={f} onClick={()=>setFilter(f)}
            style={{padding:"6px 12px", borderRadius:"100px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"12px", fontWeight:"600",
              background:filter===f?"#4f46e5":"#1e293b", color:filter===f?"white":"#64748b"}}>
            {label}
          </button>
        ))}
      </div>
      <div style={{flex:1, overflowY:"auto", padding:"0 16px"}} className="no-scrollbar">
        {visible.map(p=>(
          <div key={p.id} style={{background:"rgba(15,23,42,0.7)", borderRadius:"16px", padding:"14px", marginBottom:"10px", display:"flex", alignItems:"center", gap:"12px"}}>
            {p.photo_url
              ? <img src={p.photo_url} alt={p.name} style={{width:"44px", height:"44px", objectFit:"cover", borderRadius:"10px", flexShrink:0}} />
              : <span style={{fontSize:"28px"}}>📦</span>
            }
            <div style={{flex:1, minWidth:0}}>
              <p style={{fontSize:"14px", fontWeight:"700", color:"#e2e8f0", marginBottom:"2px"}}>{p.name}</p>
              <p style={{fontSize:"12px", color:"#64748b"}}>{fmt(p.price)}</p>
            </div>
            {editId===p.id ? (
              <div style={{display:"flex", gap:"6px", alignItems:"center"}}>
                <input type="number" value={editVal} onChange={e=>setEditVal(e.target.value)} autoFocus
                  style={{width:"60px", background:"#0f172a", border:"1px solid #4f46e5", borderRadius:"8px", padding:"4px 8px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit"}} />
                <button onClick={()=>saveStock(p.id,editVal)} style={{background:"#4f46e5", border:"none", borderRadius:"8px", padding:"6px 10px", color:"white", fontSize:"12px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>✓</button>
                <button onClick={()=>setEditId(null)} style={{background:"#334155", border:"none", borderRadius:"8px", padding:"6px 10px", color:"#94a3b8", fontSize:"12px", cursor:"pointer", fontFamily:"inherit"}}>✕</button>
              </div>
            ) : (
              <div style={{display:"flex", alignItems:"center", gap:"6px"}}>
                <button onClick={()=>adjust(p.id,-1)} style={{width:"28px", height:"28px", background:"#334155", border:"none", borderRadius:"50%", color:"#e2e8f0", cursor:"pointer", fontFamily:"inherit", fontSize:"16px"}}>−</button>
                <button onClick={()=>{setEditId(p.id);setEditVal(p.stock.toString());}}
                  style={{minWidth:"36px", textAlign:"center", fontWeight:"700", fontSize:"14px", borderRadius:"8px", padding:"2px 4px", cursor:"pointer", border:"none", fontFamily:"inherit",
                    background:"transparent", color:p.stock===0?"#f87171":p.stock<=(p.threshold||5)?"#fbbf24":"#e2e8f0"}}>
                  {p.stock}
                </button>
                <button onClick={()=>adjust(p.id,1)} style={{width:"28px", height:"28px", background:"#334155", border:"none", borderRadius:"50%", color:"#e2e8f0", cursor:"pointer", fontFamily:"inherit", fontSize:"16px"}}>+</button>
                <button onClick={()=>{setEditProduct(p);document.body.classList.add("checkout-open");}}
                  style={{width:"28px", height:"28px", background:"transparent", border:"none", color:"#818cf8", cursor:"pointer", fontFamily:"inherit", fontSize:"16px"}}>✏️</button>
                <button onClick={()=>{ if(confirm("Delete this product?")) onDelete(p.id); }}
                  style={{width:"28px", height:"28px", background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontFamily:"inherit", fontSize:"16px"}}>🗑</button>
              </div>
            )}
          </div>
        ))}
        {visible.length===0 && <p style={{color:"#475569", fontSize:"14px", textAlign:"center", marginTop:"40px"}}>No items</p>}
      </div>

      {/* Edit Product Overlay */}
      {editProduct && (
        <EditProductOverlay
          product={editProduct}
          categories={categories}
          onSave={async (updates, photoFile) => {
            let photo_url = editProduct.photo_url;
            if (photoFile) {
              const ext  = photoFile.name.split(".").pop();
              const path = `${editProduct.shop_id}/${Date.now()}.${ext}`;
              const { error: upErr } = await supabase.storage.from("product-images").upload(path, photoFile, { upsert:true });
              if (!upErr) {
                const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(path);
                photo_url = urlData.publicUrl;
              }
            }
            await updateProd(editProduct.id, { ...updates, photo_url });
            setProducts(prev=>prev.map(p=>p.id===editProduct.id?{...p,...updates,photo_url}:p));
            setEditProduct(null);
            document.body.classList.remove("checkout-open");
            showToast("Product updated");
          }}
          onClose={()=>{setEditProduct(null);document.body.classList.remove("checkout-open");}}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   REPORTS VIEW
══════════════════════════════════════════════════════════════════ */
function ReportsView({ sales, expenses, todaySales, todayRev, shopName, onAddExpense, onDeleteExpense }) {
  const [exportMonth, setExportMonth] = useState(()=>{ const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}`; });
  const [expLabel, setExpLabel] = useState("");
  const [expAmount, setExpAmount] = useState("");
  const [tab, setTab] = useState("summary");
  const [historyDate, setHistoryDate] = useState(()=>new Date().toISOString().split("T")[0]);
  const [expandedSale, setExpandedSale] = useState(null);
  const [rangeType, setRangeType] = useState("today"); // today|week|month|custom
  const [customFrom, setCustomFrom] = useState(()=>new Date().toISOString().split("T")[0]);
  const [customTo,   setCustomTo  ] = useState(()=>new Date().toISOString().split("T")[0]);

  const getRangeSales = () => {
    const now = new Date();
    if (rangeType==="today") {
      return sales.filter(s=>new Date(s.ts).toDateString()===now.toDateString());
    }
    if (rangeType==="week") {
      const weekAgo = new Date(now); weekAgo.setDate(now.getDate()-6); weekAgo.setHours(0,0,0,0);
      return sales.filter(s=>new Date(s.ts)>=weekAgo);
    }
    if (rangeType==="month") {
      return sales.filter(s=>new Date(s.ts).getMonth()===now.getMonth()&&new Date(s.ts).getFullYear()===now.getFullYear());
    }
    if (rangeType==="custom") {
      const from = new Date(customFrom); from.setHours(0,0,0,0);
      const to   = new Date(customTo);   to.setHours(23,59,59,999);
      return sales.filter(s=>new Date(s.ts)>=from&&new Date(s.ts)<=to);
    }
    return [];
  };

  const getRangeExpenses = () => {
    const now = new Date();
    if (rangeType==="today") return expenses.filter(e=>new Date(e.ts).toDateString()===now.toDateString());
    if (rangeType==="week") {
      const weekAgo = new Date(now); weekAgo.setDate(now.getDate()-6); weekAgo.setHours(0,0,0,0);
      return expenses.filter(e=>new Date(e.ts)>=weekAgo);
    }
    if (rangeType==="month") return expenses.filter(e=>new Date(e.ts).getMonth()===now.getMonth()&&new Date(e.ts).getFullYear()===now.getFullYear());
    if (rangeType==="custom") {
      const from = new Date(customFrom); from.setHours(0,0,0,0);
      const to   = new Date(customTo);   to.setHours(23,59,59,999);
      return expenses.filter(e=>new Date(e.ts)>=from&&new Date(e.ts)<=to);
    }
    return [];
  };

  const rangeLabel = rangeType==="today"?"Today":rangeType==="week"?"Last 7 Days":rangeType==="month"?"This Month":`${customFrom} → ${customTo}`;

  const todayExp    = expenses.filter(e=>new Date(e.ts).toDateString()===new Date().toDateString());
  const todayExpTotal = todayExp.reduce((s,e)=>s+e.amount, 0);
  const cashSales   = todaySales.filter(s=>s.method==="cash").length;
  const cardSales   = todaySales.filter(s=>s.method==="card").length;
  const avgSale     = todaySales.length>0?todayRev/todaySales.length:0;

  const itemMap = {};
  todaySales.forEach(s=>s.items.forEach(i=>{ if(!itemMap[i.name]) itemMap[i.name]={qty:0,rev:0}; itemMap[i.name].qty+=i.qty; itemMap[i.name].rev+=i.price*i.qty; }));
  const topItems = Object.entries(itemMap).sort((a,b)=>b[1].qty-a[1].qty).slice(0,5);
  const maxQty   = topItems[0]?.[1].qty||1;

  const exportPDF = () => {
    const [year, month] = exportMonth.split("-").map(Number);
    const filtered = sales.filter(s=>{ const d=new Date(s.ts); return d.getFullYear()===year&&d.getMonth()+1===month; });
    if (filtered.length===0) { alert("No sales for this month."); return; }
    const label = new Date(year,month-1).toLocaleDateString("en-KE",{month:"long",year:"numeric"});
    const doc = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
    doc.setFillColor(79,70,229); doc.rect(0,0,210,28,"F");
    doc.setTextColor(255,255,255); doc.setFontSize(18); doc.setFont("helvetica","bold");
    doc.text("QuickPOS — Monthly Report", 14, 12);
    doc.setFontSize(10); doc.setFont("helvetica","normal");
    doc.text(`${shopName}  |  ${label}`, 14, 21);
    const total = filtered.reduce((s,x)=>s+x.total,0);
    autoTable(doc, { startY:35, head:[["Metric","Value"]], body:[["Total Revenue",fmt(total)],["Transactions",filtered.length.toString()]], headStyles:{fillColor:[79,70,229],textColor:255}, margin:{left:14,right:14} });
    autoTable(doc, { startY:doc.lastAutoTable.finalY+10, head:[["Date","Items","Payment","Total"]], body:filtered.map(s=>[fmtDt(s.ts),s.items.map(i=>`${i.name} x${i.qty}`).join(", "),s.method==="cash"?"Cash":"M-Pesa",fmt(s.total)]), headStyles:{fillColor:[79,70,229],textColor:255}, bodyStyles:{fontSize:8}, margin:{left:14,right:14} });
    doc.save(`QuickPOS_${shopName}_${label}.pdf`);
  };

  const addExpense = async () => {
    if (!expLabel.trim() || !parseFloat(expAmount)) return;
    await onAddExpense(expLabel.trim(), parseFloat(expAmount));
    setExpLabel(""); setExpAmount("");
  };

  return (
    <div style={{flex:1, overflowY:"auto", padding:"12px 16px"}} className="no-scrollbar">
      {/* Tabs */}
      <div style={{display:"flex", gap:"8px", marginBottom:"12px"}}>
        {[["summary","📊 Summary"],["history","🧾 History"],["expenses","💸 Expenses"],["pdf","📥 PDF"]].map(([t,label])=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{flex:1, padding:"8px", borderRadius:"10px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"11px", fontWeight:"700",
              background:tab===t?"#4f46e5":"#1e293b", color:tab===t?"white":"#64748b"}}>
            {label}
          </button>
        ))}
      </div>

      {tab==="summary" && (
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
          {/* Range selector */}
          <div style={{display:"flex", gap:"6px", flexWrap:"wrap"}}>
            {[["today","Today"],["week","7 Days"],["month","Month"],["custom","Custom"]].map(([r,label])=>(
              <button key={r} onClick={()=>setRangeType(r)}
                style={{padding:"6px 12px", borderRadius:"100px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"12px", fontWeight:"600",
                  background:rangeType===r?"#4f46e5":"#1e293b", color:rangeType===r?"white":"#64748b"}}>
                {label}
              </button>
            ))}
          </div>
          {rangeType==="custom" && (
            <div style={{display:"flex", gap:"8px"}}>
              <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}
                style={{flex:1, background:"#1e293b", border:"1px solid #334155", borderRadius:"10px", padding:"8px", color:"#f1f5f9", fontSize:"13px", outline:"none", fontFamily:"inherit"}} />
              <input type="date" value={customTo} onChange={e=>setCustomTo(e.target.value)}
                style={{flex:1, background:"#1e293b", border:"1px solid #334155", borderRadius:"10px", padding:"8px", color:"#f1f5f9", fontSize:"13px", outline:"none", fontFamily:"inherit"}} />
            </div>
          )}
          {(()=>{
            const rangeSales    = getRangeSales();
            const rangeExp      = getRangeExpenses();
            const rangeRev      = rangeSales.reduce((s,x)=>s+x.total,0);
            const rangeExpTotal = rangeExp.reduce((s,e)=>s+e.amount,0);
            const rangeCash     = rangeSales.filter(s=>s.method==="cash").length;
            const rangeMpesa    = rangeSales.filter(s=>s.method==="card").length;
            const rItemMap = {};
            rangeSales.forEach(s=>s.items.forEach(i=>{ if(!rItemMap[i.name]) rItemMap[i.name]={qty:0,rev:0}; rItemMap[i.name].qty+=i.qty; rItemMap[i.name].rev+=i.price*i.qty; }));
            const rTopItems = Object.entries(rItemMap).sort((a,b)=>b[1].qty-a[1].qty).slice(0,5);
            const rMaxQty = rTopItems[0]?.[1].qty||1;
            return (
              <>
                <div style={{background:"#4f46e5", borderRadius:"16px", padding:"16px"}}>
                  <p style={{color:"#c7d2fe", fontSize:"11px", fontWeight:"600"}}>{rangeLabel} Revenue</p>
                  <p style={{color:"white", fontSize:"28px", fontWeight:"800", marginTop:"4px"}}>{fmt(rangeRev)}</p>
                  <p style={{color:"#c7d2fe", fontSize:"11px", marginTop:"4px"}}>{rangeSales.length} transactions</p>
                </div>
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px"}}>
                  <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px"}}>
                    <p style={{color:"#64748b", fontSize:"11px"}}>💵 Cash</p>
                    <p style={{color:"#f1f5f9", fontSize:"22px", fontWeight:"800", marginTop:"4px"}}>{rangeCash}</p>
                  </div>
                  <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px"}}>
                    <p style={{color:"#64748b", fontSize:"11px"}}>💳 M-Pesa</p>
                    <p style={{color:"#f1f5f9", fontSize:"22px", fontWeight:"800", marginTop:"4px"}}>{rangeMpesa}</p>
                  </div>
                  <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px"}}>
                    <p style={{color:"#64748b", fontSize:"11px"}}>💸 Expenses</p>
                    <p style={{color:"#f87171", fontSize:"22px", fontWeight:"800", marginTop:"4px"}}>{fmt(rangeExpTotal)}</p>
                  </div>
                  <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px"}}>
                    <p style={{color:"#64748b", fontSize:"11px"}}>📈 Profit</p>
                    <p style={{color:"#34d399", fontSize:"22px", fontWeight:"800", marginTop:"4px"}}>{fmt(rangeRev-rangeExpTotal)}</p>
                  </div>
                </div>
                {rTopItems.length>0 && (
                  <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px"}}>
                    <p style={{fontSize:"13px", fontWeight:"700", marginBottom:"12px"}}>🏆 Top Sellers — {rangeLabel}</p>
                    {rTopItems.map(([name,data],idx)=>(
                      <div key={name} style={{display:"flex", alignItems:"center", gap:"8px", marginBottom:"10px"}}>
                        <span style={{color:"#475569", fontSize:"11px", width:"16px", fontWeight:"700"}}>{idx+1}</span>
                        <div style={{flex:1}}>
                          <p style={{fontSize:"12px", color:"#cbd5e1", fontWeight:"600"}}>{name}</p>
                          <div style={{height:"4px", background:"#334155", borderRadius:"2px", marginTop:"4px"}}>
                            <div style={{height:"100%", background:"#4f46e5", borderRadius:"2px", width:`${(data.qty/rMaxQty)*100}%`}} />
                          </div>
                        </div>
                        <span style={{fontSize:"11px", fontWeight:"700", color:"#818cf8"}}>×{data.qty}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {tab==="history" && (
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
          {/* Date picker */}
          <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px", display:"flex", alignItems:"center", gap:"10px"}}>
            <span style={{fontSize:"16px"}}>📅</span>
            <input type="date" value={historyDate} onChange={e=>setHistoryDate(e.target.value)}
              style={{flex:1, background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"8px 12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit"}} />
          </div>
          {/* Sales for selected date */}
          {(()=>{
            const daySales = sales.filter(s=>new Date(s.ts).toDateString()===new Date(historyDate).toDateString());
            const dayTotal = daySales.reduce((s,x)=>s+x.total,0);
            if(daySales.length===0) return <p style={{color:"#475569", fontSize:"14px", textAlign:"center", marginTop:"40px"}}>No sales on this date</p>;
            return (
              <>
                <div style={{background:"#4f46e5", borderRadius:"14px", padding:"14px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <div>
                    <p style={{color:"#c7d2fe", fontSize:"11px", fontWeight:"600"}}>Total Revenue</p>
                    <p style={{color:"white", fontSize:"22px", fontWeight:"800"}}>{fmt(dayTotal)}</p>
                  </div>
                  <p style={{color:"#c7d2fe", fontSize:"13px", fontWeight:"600"}}>{daySales.length} sales</p>
                </div>
                {daySales.map(s=>(
                  <div key={s.id} style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", overflow:"hidden"}}>
                    <div onClick={()=>setExpandedSale(expandedSale===s.id?null:s.id)}
                      style={{padding:"14px", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer"}}>
                      <div>
                        <p style={{fontSize:"13px", fontWeight:"700", color:"#e2e8f0", margin:"0 0 2px"}}>{fmtDt(s.ts)}</p>
                        <p style={{fontSize:"11px", color:"#64748b", margin:0}}>{s.items.length} item(s) • {s.method==="cash"?"💵 Cash":"💳 M-Pesa"}</p>
                      </div>
                      <div style={{display:"flex", alignItems:"center", gap:"10px"}}>
                        <p style={{fontSize:"15px", fontWeight:"800", color:"#818cf8"}}>{fmt(s.total)}</p>
                        <span style={{color:"#475569", fontSize:"12px"}}>{expandedSale===s.id?"▲":"▼"}</span>
                      </div>
                    </div>
                    {expandedSale===s.id && (
                      <div style={{borderTop:"1px solid #334155", padding:"12px 14px", background:"#0f172a"}}>
                        {s.items.map((item,i)=>(
                          <div key={i} style={{display:"flex", justifyContent:"space-between", marginBottom:"6px"}}>
                            <p style={{fontSize:"12px", color:"#cbd5e1"}}>{item.name}{item.unit?" ("+item.unit+")":""} x{item.qty}</p>
                            <p style={{fontSize:"12px", fontWeight:"700", color:"#818cf8"}}>{fmt(item.price*item.qty)}</p>
                          </div>
                        ))}
                        {s.method==="cash"&&s.change>0&&(
                          <p style={{fontSize:"11px", color:"#34d399", marginTop:"6px"}}>Change: {fmt(s.change)}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      )}

      {tab==="expenses" && (
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
          <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px"}}>
            <p style={{fontSize:"13px", fontWeight:"700", marginBottom:"10px"}}>Add Expense</p>
            <input value={expLabel} onChange={e=>setExpLabel(e.target.value)} placeholder="Description (e.g. Transport)"
              style={{width:"100%", background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"10px 12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit", marginBottom:"8px"}} />
            <input type="number" value={expAmount} onChange={e=>setExpAmount(e.target.value)} placeholder="Amount (KSh)"
              style={{width:"100%", background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"10px 12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit", marginBottom:"10px"}} />
            <button onClick={addExpense} disabled={!expLabel.trim()||!parseFloat(expAmount)}
              style={{width:"100%", padding:"12px", borderRadius:"10px", background:"#4f46e5", border:"none", color:"white", fontSize:"14px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit",
                opacity:!expLabel.trim()||!parseFloat(expAmount)?0.5:1}}>
              Add Expense
            </button>
          </div>
          {expenses.slice(0,30).map(e=>(
            <div key={e.id} style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"14px", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
              <div>
                <p style={{fontSize:"14px", fontWeight:"600", color:"#e2e8f0"}}>{e.note||e.category}</p>
                <p style={{fontSize:"11px", color:"#64748b"}}>{fmtDt(e.ts)}</p>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:"10px"}}>
                <p style={{fontSize:"15px", fontWeight:"800", color:"#f87171"}}>{fmt(e.amount)}</p>
                <button onClick={()=>{ if(confirm("Delete expense?")) onDeleteExpense(e.id); }}
                  style={{background:"none", border:"none", color:"#475569", cursor:"pointer", fontFamily:"inherit", fontSize:"16px"}}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab==="pdf" && (
        <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"16px"}}>
          <p style={{fontSize:"14px", fontWeight:"700", marginBottom:"12px"}}>📥 Monthly Report</p>
          <input type="month" value={exportMonth} onChange={e=>setExportMonth(e.target.value)}
            style={{width:"100%", background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"10px 12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit", marginBottom:"10px"}} />
          <button onClick={exportPDF}
            style={{width:"100%", padding:"14px", borderRadius:"10px", background:"#4f46e5", border:"none", color:"white", fontSize:"15px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
            Download PDF
          </button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   SETTINGS VIEW
══════════════════════════════════════════════════════════════════ */
function SettingsView({ shop, onShopUpdate, showToast, onSignOut, categories, setCategories }) {
  const [tab,       setTab      ] = useState("shop");
  const [shopName,  setShopName ] = useState(shop.name);
  const [step,      setStep     ] = useState("verify");
  const [pin0,      setPin0     ] = useState("");
  const [pin1,      setPin1     ] = useState("");
  const [pin2,      setPin2     ] = useState("");
  const [pinType,   setPinType  ] = useState("owner");
  const [error,     setError    ] = useState("");
  const [saving,    setSaving   ] = useState(false);
  const [newCat,    setNewCat   ] = useState("");

  const addCategory = async () => {
    const cat = newCat.trim();
    if (!cat) return;
    const updated = [...(categories || DEFAULT_CATEGORIES), cat];
    await updateShop(shop.id, { categories: updated });
    setCategories(updated);
    onShopUpdate({ ...shop, categories: updated });
    setNewCat("");
    showToast("Category added");
  };

  const deleteCategory = async (cat) => {
    const updated = (categories || DEFAULT_CATEGORIES).filter(c => c !== cat);
    await updateShop(shop.id, { categories: updated });
    setCategories(updated);
    onShopUpdate({ ...shop, categories: updated });
    showToast("Category removed");
  };

  const saveShopName = async () => {
    if (!shopName.trim()) return;
    setSaving(true);
    const updated = await updateShop(shop.id, { name: shopName.trim() });
    onShopUpdate(updated);
    setSaving(false);
    showToast("Shop name updated");
  };

  const handlePinKey = async (k) => {
    setError("");
    if (step==="verify") {
      if (k==="⌫") { setPin0(p=>p.slice(0,-1)); return; }
      const next = pin0 + k; setPin0(next);
      if (next.length===4) {
        const ok = await verifyOwnerPIN(shop, next);
        if (!ok) { setError("Wrong PIN"); setPin0(""); return; }
        setTimeout(()=>setStep("enter"), 200);
      }
      return;
    }
    if (k==="⌫") { (step==="enter"?setPin1:setPin2)(p=>p.slice(0,-1)); return; }
    const current = step==="enter"?pin1:pin2;
    const next = current + k;
    (step==="enter"?setPin1:setPin2)(next);
    if (next.length===4) {
      if (step==="enter") { setTimeout(()=>setStep("confirm"),200); }
      else {
        if (next!==pin1) { setError("PINs don't match"); setPin1(""); setPin2(""); setStep("enter"); return; }
        const updates = pinType==="owner" ? { ownerPin: next } : { staffPin: next };
        const updated = await updateShop(shop.id, updates);
        onShopUpdate(updated);
        setPin0(""); setPin1(""); setPin2(""); setStep("verify");
        showToast(`${pinType==="owner"?"Owner":"Staff"} PIN updated`);
      }
    }
  };

  return (
    <div style={{flex:1, overflowY:"auto", padding:"12px 16px"}} className="no-scrollbar">
      {/* Tabs */}
      <div style={{display:"flex", gap:"8px", marginBottom:"16px"}}>
        {[["shop","🏪 Shop"],["categories","🏷️ Categories"],["pin","🔑 PIN"],["account","👤 Account"]].map(([t,label])=>(
          <button key={t} onClick={()=>{setTab(t);setStep("verify");setPin0("");setPin1("");setPin2("");setError("");}}
            style={{flex:1, padding:"8px", borderRadius:"10px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"11px", fontWeight:"700",
              background:tab===t?"#4f46e5":"#1e293b", color:tab===t?"white":"#64748b"}}>
            {label}
          </button>
        ))}
      </div>

      {tab==="shop" && (
        <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"16px", display:"flex", flexDirection:"column", gap:"12px"}}>
          <p style={{fontSize:"14px", fontWeight:"700"}}>Shop Name</p>
          <input value={shopName} onChange={e=>setShopName(e.target.value)}
            style={{background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit"}} />
          <button onClick={saveShopName} disabled={saving||!shopName.trim()}
            style={{padding:"12px", borderRadius:"10px", background:"#4f46e5", border:"none", color:"white", fontSize:"14px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
            {saving?"Saving…":"Save"}
          </button>
          <div style={{borderTop:"1px solid #334155", paddingTop:"12px"}}>
            <p style={{fontSize:"12px", color:"#64748b", marginBottom:"6px"}}>Shop URL for staff:</p>
            <p style={{fontSize:"13px", color:"#818cf8", fontWeight:"600", wordBreak:"break-all"}}>
              {window.location.origin}/shop/{shop.slug}
            </p>
          </div>
        </div>
      )}

      {tab==="categories" && (
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
          <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"16px"}}>
            <p style={{fontSize:"14px", fontWeight:"700", marginBottom:"12px"}}>Add Category</p>
            <div style={{display:"flex", gap:"8px"}}>
              <input value={newCat} onChange={e=>setNewCat(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&addCategory()}
                placeholder="e.g. Electronics"
                style={{flex:1, background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"10px 12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit"}} />
              <button onClick={addCategory} disabled={!newCat.trim()}
                style={{padding:"10px 16px", borderRadius:"10px", background:"#4f46e5", border:"none", color:"white", fontSize:"14px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit", opacity:!newCat.trim()?0.5:1}}>
                Add
              </button>
            </div>
          </div>
          <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"16px"}}>
            <p style={{fontSize:"13px", fontWeight:"700", marginBottom:"12px", color:"#94a3b8"}}>Your Categories</p>
            {(categories || DEFAULT_CATEGORIES).map(cat=>(
              <div key={cat} style={{display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0", borderBottom:"1px solid #334155"}}>
                <p style={{fontSize:"14px", color:"#e2e8f0", fontWeight:"600"}}>🏷️ {cat}</p>
                <button onClick={()=>deleteCategory(cat)}
                  style={{background:"none", border:"none", color:"#475569", cursor:"pointer", fontFamily:"inherit", fontSize:"18px"}}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab==="pin" && (
        <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"16px", display:"flex", flexDirection:"column", alignItems:"center", gap:"16px"}}>
          <div style={{display:"flex", gap:"8px", width:"100%"}}>
            {[["owner","Owner"],["staff","Staff"]].map(([t,label])=>(
              <button key={t} onClick={()=>{setPinType(t);setStep("verify");setPin0("");setPin1("");setPin2("");setError("");}}
                style={{flex:1, padding:"10px", borderRadius:"10px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"13px", fontWeight:"700",
                  background:pinType===t?"#4f46e5":"#334155", color:pinType===t?"white":"#64748b"}}>
                {label} PIN
              </button>
            ))}
          </div>
          <p style={{color:"#64748b", fontSize:"13px"}}>
            {step==="verify"?"Enter current owner PIN to verify":step==="enter"?"Choose new PIN":"Confirm new PIN"}
          </p>
          <PINPad pin={step==="verify"?pin0:step==="enter"?pin1:pin2} onKey={handlePinKey} error={error} color={pinType==="owner"?"#4f46e5":"#059669"} />
        </div>
      )}

      {tab==="account" && (
        <div style={{background:"rgba(15,23,42,0.7)", borderRadius:"14px", padding:"16px", display:"flex", flexDirection:"column", gap:"12px"}}>
          <p style={{fontSize:"14px", fontWeight:"700"}}>Account</p>
          <button onClick={onSignOut}
            style={{padding:"14px", borderRadius:"10px", background:"#7f1d1d", border:"none", color:"#fca5a5", fontSize:"14px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit"}}>
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   CONTAINER FORM
══════════════════════════════════════════════════════════════════ */
function ContainerForm({ onAdd }) {
  const [name,   setName  ] = useState("");
  const [weight, setWeight] = useState("");
  const [price,  setPrice ] = useState("");
  const [unit,   setUnit  ] = useState("kg");
  const valid = name.trim() && parseFloat(weight)>0 && parseFloat(price)>0;

  const handleAdd = () => {
    onAdd({ name:name.trim(), weight:parseFloat(weight), price:parseFloat(price), unit });
    setName(""); setWeight(""); setPrice("");
  };

  return (
    <div style={{background:"#0f172a", borderRadius:"12px", padding:"12px", marginTop:"6px"}}>
      <p style={{fontSize:"12px", color:"#64748b", fontWeight:"600", margin:"0 0 8px"}}>Add Container</p>
      <div style={{display:"flex", flexDirection:"column", gap:"8px"}}>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Name (e.g. Small bucket)"
          style={{background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", padding:"8px 10px", color:"#f1f5f9", fontSize:"13px", outline:"none", fontFamily:"inherit"}} />
        <div style={{display:"flex", gap:"8px"}}>
          <input type="number" value={weight} onChange={e=>setWeight(e.target.value)} placeholder="Weight"
            style={{flex:1, background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", padding:"8px 10px", color:"#f1f5f9", fontSize:"13px", outline:"none", fontFamily:"inherit"}} />
          <select value={unit} onChange={e=>setUnit(e.target.value)}
            style={{background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", padding:"8px 10px", color:"#f1f5f9", fontSize:"13px", outline:"none", fontFamily:"inherit"}}>
            {["kg","g","L","pcs"].map(u=><option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <input type="number" value={price} onChange={e=>setPrice(e.target.value)} placeholder="Price (KSh)"
          style={{background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", padding:"8px 10px", color:"#f1f5f9", fontSize:"13px", outline:"none", fontFamily:"inherit"}} />
        <button onClick={handleAdd} disabled={!valid}
          style={{padding:"10px", borderRadius:"8px", background:"#4f46e5", border:"none", color:"white", fontSize:"13px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit", opacity:!valid?0.5:1}}>
          + Add Container
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   EDIT PRODUCT OVERLAY
══════════════════════════════════════════════════════════════════ */
function EditProductOverlay({ product, categories, onSave, onClose }) {
  const shopCats = categories || DEFAULT_CATEGORIES;
  const [form,         setForm        ] = useState({
    name:      product.name      || "",
    price:     product.price     || "",
    barcode:   product.barcode   || "",
    stock:     product.stock     || 0,
    threshold: product.threshold || 5,
    category:  product.category  || shopCats[0],
    unit:      product.unit      || "",
    fractional:product.fractional|| false,
  });
  const [saving,       setSaving      ] = useState(false);
  const [saveError,    setSaveError   ] = useState("");
  const [photoFile,    setPhotoFile   ] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(product.photo_url||null);
  const set = (k,v) => setForm(p=>({...p,[k]:v}));
  const valid = form.name.trim() && parseFloat(form.price)>0 && parseFloat(form.stock)>=0 && parseFloat(form.threshold)>=0;

  const handlePhoto = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    setSaveError(""); setSaving(true);
    try {
      await onSave({ ...form, price:parseFloat(form.price), stock:parseFloat(form.stock)||0, threshold:parseFloat(form.threshold)||5 }, photoFile);
    } catch(e) {
      setSaveError(e.message || "Failed to save.");
      console.error("editProduct error:", e);
    } finally { setSaving(false); }
  };

  return (
    <div style={{position:"fixed", inset:0, zIndex:200, display:"flex", alignItems:"flex-end", background:"rgba(0,0,0,0.7)"}}>
      <div style={{background:"rgba(15,23,42,0.92)", borderRadius:"24px 24px 0 0", width:"100%", padding:"20px", maxHeight:"90vh", overflowY:"auto", fontFamily:"'DM Sans',system-ui,sans-serif"}} className="no-scrollbar">
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"16px"}}>
          <p style={{fontSize:"18px", fontWeight:"800"}}>Edit Product</p>
          <button onClick={onClose} style={{background:"none", border:"none", color:"#64748b", fontSize:"28px", cursor:"pointer", lineHeight:1}}>×</button>
        </div>
        <div style={{display:"flex", flexDirection:"column", gap:"12px"}}>
          {/* Photo */}
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>Product Photo</label>
            <label style={{display:"flex", alignItems:"center", justifyContent:"center", gap:"10px", background:"#0f172a", border:"2px dashed #334155", borderRadius:"12px", padding:"16px", cursor:"pointer", color:"#64748b", fontSize:"13px", fontWeight:"600"}}>
              {photoPreview
                ? <img src={photoPreview} alt="preview" style={{width:"80px", height:"80px", objectFit:"cover", borderRadius:"10px"}} />
                : <><span style={{fontSize:"28px"}}>📷</span><span>Tap to change photo</span></>
              }
              <input type="file" accept="image/*" onChange={handlePhoto} style={{display:"none"}} />
            </label>
            {photoPreview && (
              <button onClick={()=>{setPhotoFile(null);setPhotoPreview(null);}}
                style={{marginTop:"6px", background:"none", border:"none", color:"#f87171", fontSize:"12px", cursor:"pointer", fontFamily:"inherit"}}>
                ✕ Remove photo
              </button>
            )}
          </div>
          {/* Fields */}
          {[
            {key:"name",      label:"Product Name",    placeholder:"e.g. Sugar 1kg"},
            {key:"price",     label:"Price (KSh)",     placeholder:"0", type:"number"},
            {key:"barcode",   label:"Barcode",         placeholder:"Optional"},
            {key:"stock",     label:"Stock Qty",       placeholder:"0", type:"number"},
            {key:"threshold", label:"Low Stock Alert", placeholder:"5", type:"number"},
          ].map(f=>(
            <div key={f.key}>
              <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>{f.label}</label>
              <input type={f.type||"text"} value={form[f.key]} onChange={e=>set(f.key,e.target.value)} placeholder={f.placeholder}
                style={{width:"100%", background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit"}} />
            </div>
          ))}
          {/* Category */}
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>Category</label>
            <div style={{display:"flex", flexWrap:"wrap", gap:"8px"}}>
              {shopCats.map(c=>(
                <button key={c} onClick={()=>set("category",c)}
                  style={{padding:"6px 12px", borderRadius:"100px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"12px", fontWeight:"600",
                    background:form.category===c?"#4f46e5":"#334155", color:form.category===c?"white":"#94a3b8"}}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          {/* Unit */}
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>Unit</label>
            <div style={{display:"flex", flexWrap:"wrap", gap:"8px"}}>
              {["—","pcs","kg","g","L","litres","crates","cartons"].map(u=>(
                <button key={u} onClick={()=>set("unit", u==="—"?"":u)}
                  style={{padding:"6px 12px", borderRadius:"10px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"13px", fontWeight:"600",
                    background:(u==="—"&&!form.unit)||(form.unit===u)?"#4f46e5":"#334155", color:(u==="—"&&!form.unit)||(form.unit===u)?"white":"#94a3b8"}}>
                  {u}
                </button>
              ))}
            </div>
          </div>
          {/* Fractional toggle */}
          <div style={{background:"#0f172a", borderRadius:"12px", padding:"14px", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
            <div>
              <p style={{fontSize:"13px", fontWeight:"700", color:"#e2e8f0", margin:"0 0 2px"}}>Fractional Selling</p>
              <p style={{fontSize:"11px", color:"#64748b", margin:0}}>Allow selling by weight or volume</p>
            </div>
            <button onClick={()=>set("fractional",!form.fractional)}
              style={{width:"44px", height:"24px", borderRadius:"100px", border:"none", cursor:"pointer", position:"relative",
                background:form.fractional?"#4f46e5":"#334155", transition:"background 0.2s"}}>
              <span style={{position:"absolute", top:"3px", left:form.fractional?"23px":"3px", width:"18px", height:"18px", background:"white", borderRadius:"50%", transition:"left 0.2s", display:"block"}} />
            </button>
          </div>
          {/* Container management */}
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"8px"}}>
              Containers <span style={{color:"#475569", textTransform:"none", fontWeight:"400"}}>(optional — for products sold in containers)</span>
            </label>
            {(form.containers||[]).map((c,i)=>(
              <div key={i} style={{display:"flex", alignItems:"center", gap:"8px", marginBottom:"8px", background:"#0f172a", borderRadius:"10px", padding:"10px 12px"}}>
                <div style={{flex:1}}>
                  <p style={{fontSize:"13px", fontWeight:"700", color:"#e2e8f0", margin:"0 0 2px"}}>🪣 {c.name}</p>
                  <p style={{fontSize:"11px", color:"#64748b", margin:0}}>{c.weight} {c.unit||"kg"} — {fmt(c.price)}</p>
                </div>
                <button onClick={()=>set("containers",(form.containers||[]).filter((_,j)=>j!==i))}
                  style={{background:"none", border:"none", color:"#f87171", cursor:"pointer", fontFamily:"inherit", fontSize:"18px"}}>🗑</button>
              </div>
            ))}
            <ContainerForm onAdd={(c)=>set("containers",[...(form.containers||[]),c])} />
          </div>

          {saveError && <p style={{color:"#f87171", fontSize:"13px", background:"rgba(239,68,68,0.1)", padding:"10px 12px", borderRadius:"10px"}}>{saveError}</p>}
          <button disabled={!valid||saving} onClick={handleSave}
            style={{width:"100%", padding:"16px", borderRadius:"12px", background:"#4f46e5", border:"none", color:"white", fontSize:"16px", fontWeight:"700",
              cursor:"pointer", fontFamily:"inherit", opacity:!valid||saving?0.5:1, marginTop:"4px"}}>
            {saving?"Saving…":"Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   ADD PRODUCT OVERLAY
══════════════════════════════════════════════════════════════════ */
function AddProductOverlay({ onSave, onClose, categories }) {
  const shopCats = categories || DEFAULT_CATEGORIES;
  const [form,         setForm        ] = useState({ name:"", price:"", barcode:"", stock:"0", threshold:"5", category:shopCats[0]||"Other", fractional:false, unit:"", containers:[] });
  const [saving,       setSaving      ] = useState(false);
  const [saveError,    setSaveError   ] = useState("");
  const [photoFile,    setPhotoFile   ] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const set   = (k,v) => setForm(p=>({...p,[k]:v}));
  const valid = form.name.trim() && parseFloat(form.price)>0 && parseFloat(form.stock)>=0 && parseFloat(form.threshold)>=0;

  const handlePhoto = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    setSaveError("");
    setSaving(true);
    try {
      await onSave({ ...form, price:parseFloat(form.price), stock:parseFloat(form.stock)||0, threshold:parseFloat(form.threshold)||5 }, photoFile);
    } catch(e) {
      setSaveError(e.message || "Failed to save. Check your connection.");
      console.error("addProduct error:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{position:"fixed", inset:0, zIndex:200, display:"flex", alignItems:"flex-end", background:"rgba(0,0,0,0.7)"}}>
      <div style={{background:"rgba(15,23,42,0.92)", borderRadius:"24px 24px 0 0", width:"100%", padding:"20px", maxHeight:"90vh", overflowY:"auto", ...S}} className="no-scrollbar">
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"16px"}}>
          <p style={{fontSize:"18px", fontWeight:"800"}}>New Product</p>
          <button onClick={onClose} style={{background:"none", border:"none", color:"#64748b", fontSize:"28px", cursor:"pointer", lineHeight:1}}>×</button>
        </div>
        <div style={{display:"flex", flexDirection:"column", gap:"12px"}}>
          {/* Photo upload */}
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>Product Photo</label>
            <label style={{display:"flex", alignItems:"center", justifyContent:"center", gap:"10px", background:"#0f172a", border:"2px dashed #334155", borderRadius:"12px", padding:"16px", cursor:"pointer", color:"#64748b", fontSize:"13px", fontWeight:"600"}}>
              {photoPreview
                ? <img src={photoPreview} alt="preview" style={{width:"80px", height:"80px", objectFit:"cover", borderRadius:"10px"}} />
                : <><span style={{fontSize:"28px"}}>📷</span><span>Tap to add photo</span></>
              }
              <input type="file" accept="image/*" onChange={handlePhoto} style={{display:"none"}} />
            </label>
            {photoPreview && (
              <button onClick={()=>{setPhotoFile(null);setPhotoPreview(null);}}
                style={{marginTop:"6px", background:"none", border:"none", color:"#f87171", fontSize:"12px", cursor:"pointer", fontFamily:"inherit"}}>
                ✕ Remove photo
              </button>
            )}
          </div>

          {/* Core fields */}
          {[
            {key:"name",      label:"Product Name",    placeholder:"e.g. Sugar 1kg"},
            {key:"price",     label:`Price (KSh)${form.fractional?" per "+( form.unit||"unit"):""}`, placeholder:"0", type:"number"},
            {key:"barcode",   label:"Barcode",         placeholder:"Optional"},
            {key:"stock",     label:form.fractional?`Stock (${form.unit||"units"})`:"Stock Qty", placeholder:"0", type:"number", step:form.fractional?"0.01":"1"},
            {key:"threshold", label:"Low Stock Alert", placeholder:"5", type:"number", step:form.fractional?"0.01":"1"},
          ].map(f=>(
            <div key={f.key}>
              <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>{f.label}</label>
              <input type={f.type||"text"} value={form[f.key]} onChange={e=>set(f.key,e.target.value)} placeholder={f.placeholder} step={f.step}
                style={{width:"100%", background:"#0f172a", border:"1px solid #334155", borderRadius:"10px", padding:"12px", color:"#f1f5f9", fontSize:"14px", outline:"none", fontFamily:"inherit"}} />
            </div>
          ))}

          {/* Fractional selling toggle */}
          <div style={{background:"#0f172a", borderRadius:"12px", padding:"14px", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
            <div>
              <p style={{fontSize:"13px", fontWeight:"700", color:"#e2e8f0", margin:"0 0 2px"}}>Fractional Selling</p>
              <p style={{fontSize:"11px", color:"#64748b", margin:0}}>Allow selling by weight or volume (e.g. 0.5 kg)</p>
            </div>
            <button onClick={()=>set("fractional",!form.fractional)}
              style={{width:"44px", height:"24px", borderRadius:"100px", border:"none", cursor:"pointer", fontFamily:"inherit", position:"relative",
                background:form.fractional?"#4f46e5":"#334155", transition:"background 0.2s"}}>
              <span style={{position:"absolute", top:"3px", left:form.fractional?"23px":"3px", width:"18px", height:"18px", background:"white", borderRadius:"50%", transition:"left 0.2s", display:"block"}} />
            </button>
          </div>
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>Category</label>
            <div style={{display:"flex", flexWrap:"wrap", gap:"8px"}}>
              {shopCats.map(c=>(
                <button key={c} onClick={()=>set("category",c)}
                  style={{padding:"6px 12px", borderRadius:"100px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"12px", fontWeight:"600",
                    background:form.category===c?"#4f46e5":"#334155", color:form.category===c?"white":"#94a3b8"}}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"6px"}}>
              Unit <span style={{color:"#475569", textTransform:"none", fontWeight:"400"}}>(optional)</span>
            </label>
            <div style={{display:"flex", flexWrap:"wrap", gap:"8px"}}>
              {["—","pcs","kg","g","L","litres","crates","cartons"].map(u=>(
                <button key={u} onClick={()=>set("unit", u==="—"?"":u)}
                  style={{padding:"6px 12px", borderRadius:"10px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"13px", fontWeight:"600",
                    background:(u==="—"&&!form.unit)||(form.unit===u)?"#4f46e5":"#334155", color:(u==="—"&&!form.unit)||(form.unit===u)?"white":"#94a3b8"}}>
                  {u}
                </button>
              ))}
            </div>
          </div>
          {/* Containers */}
          <div>
            <label style={{fontSize:"11px", color:"#64748b", fontWeight:"600", textTransform:"uppercase", letterSpacing:"0.5px", display:"block", marginBottom:"8px"}}>
              Containers <span style={{color:"#475569", textTransform:"none", fontWeight:"400"}}>(optional)</span>
            </label>
            {(form.containers||[]).map((c,i)=>(
              <div key={i} style={{display:"flex", alignItems:"center", gap:"8px", marginBottom:"8px", background:"#0f172a", borderRadius:"10px", padding:"10px 12px"}}>
                <div style={{flex:1}}>
                  <p style={{fontSize:"13px", fontWeight:"700", color:"#e2e8f0", margin:"0 0 2px"}}>🪣 {c.name}</p>
                  <p style={{fontSize:"11px", color:"#64748b", margin:0}}>{c.weight} {c.unit||"kg"} — {fmt(c.price)}</p>
                </div>
                <button onClick={()=>set("containers",(form.containers||[]).filter((_,j)=>j!==i))}
                  style={{background:"none", border:"none", color:"#f87171", cursor:"pointer", fontFamily:"inherit", fontSize:"18px"}}>🗑</button>
              </div>
            ))}
            <ContainerForm onAdd={(c)=>set("containers",[...(form.containers||[]),c])} />
          </div>

          {saveError && <p style={{color:"#f87171", fontSize:"13px", background:"rgba(239,68,68,0.1)", padding:"10px 12px", borderRadius:"10px"}}>{saveError}</p>}
          <button disabled={!valid||saving} onClick={handleSave}
            style={{width:"100%", padding:"16px", borderRadius:"12px", background:"#4f46e5", border:"none", color:"white", fontSize:"16px", fontWeight:"700",
              cursor:"pointer", fontFamily:"inherit", opacity:!valid||saving?0.5:1, marginTop:"4px"}}>
            {saving?"Saving…":"Save Product"}
          </button>
        </div>
      </div>
    </div>
  );
}

