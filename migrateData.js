import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, getDocs, collection } from "firebase/firestore";

// Source: Old Firebase
const oldConfig = {
  apiKey: "AIzaSyDGhwmtpHazLrDWDXjK3WoGPh610mrJeaI",
  authDomain: "whatanagent-a1e59.firebaseapp.com",
  projectId: "whatanagent-a1e59"
};
const oldApp = initializeApp(oldConfig, "oldApp");
const oldDb = getFirestore(oldApp);

// Target: New Firebase
const newConfig = {
  apiKey: "AIzaSyBR4wTVSfzBEJtbkogCaVYj3lDMbIgWtAc",
  authDomain: "businesswhatanagent.firebaseapp.com",
  projectId: "businesswhatanagent"
};
const newApp = initializeApp(newConfig, "newApp");
const newDb = getFirestore(newApp);

async function runMigration() {
  console.log("🚀 Starting migration from whatanagent-a1e59 -> businesswhatanagent...");

  // 1. Migrate Settings
  console.log("1. Migrating appData/settings...");
  try {
    const sSnap = await getDoc(doc(oldDb, "appData", "settings"));
    if (sSnap.exists()) {
      const data = sSnap.data();
      await setDoc(doc(newDb, "appData", "settings"), {
        ACTIVE_AI_PROVIDER: data.ACTIVE_AI_PROVIDER || "deepseek",
        DEEPSEEK_API_KEY: data.DEEPSEEK_API_KEY || "sk-072936f291764d9ba25f44ddb8c7baef",
        GEMINI_API_KEY: data.GEMINI_API_KEY || "",
        WHATSAPP_TOKEN: data.WHATSAPP_TOKEN || "",
        PHONE_NUMBER_ID: data.PHONE_NUMBER_ID || "1209839585553898",
        VERIFY_TOKEN: data.VERIFY_TOKEN || "my_whatsapp_agent_verify_token_2026",
        API_VERSION: data.API_VERSION || "v20.0"
      }, { merge: true });
      console.log("   ✅ Settings migrated successfully.");
    } else {
      console.log("   ⚠️ No existing settings found, setting defaults.");
    }
  } catch (err) {
    console.warn("   Settings error:", err.message);
  }

  // 2. Migrate Knowledge
  console.log("2. Migrating appData/knowledge...");
  try {
    const kSnap = await getDoc(doc(oldDb, "appData", "knowledge"));
    const data = kSnap.exists() ? kSnap.data() : {};
    await setDoc(doc(newDb, "appData", "knowledge"), {
      companyProfile: data.companyProfile || "AL SAHAM AL AHMAR METAL SCRAP TR",
      timings: data.timings || "7 AM TO 12 PM then 3 pm to 7 pm, Saturday to Thursday",
      locationAndBranches: data.locationAndBranches || "SAJA IND AREA SHARJAH UAE branches = axiom polymer in ummalquwain 2 brandspoint llc 3 al qaryan industries in karachi pakistan",
      googleMapsLink: data.googleMapsLink || "https://maps.google.com/?q=Saja+Industrial+Area+Sharjah",
      products: data.products || "HDPE100 PIPES SCRAP, PVC PIPE SCRAP, PET SCRAP PC SCRAP ALUMINIUM ACSR SCRAP ALUIUM DROSS SCRAP",
      logistics: data.logistics || "We offer LOCAL TRANSPORT AND ALSO PROVIDE SEA TRANSPORT",
      customRules: data.customRules || "Always greet the customer politely. Do not provide prices unless explicitly asked.",
      onboardingPrompt: data.onboardingPrompt || "Welcome the customer warmly to Al Saham Al Ahmar Metal Scrap TR."
    }, { merge: true });
    console.log("   ✅ Knowledge base migrated successfully.");
  } catch (err) {
    console.warn("   Knowledge error:", err.message);
  }

  // 3. Migrate Contacts
  console.log("3. Migrating contacts collection...");
  try {
    const contactsSnap = await getDocs(collection(oldDb, "contacts"));
    let count = 0;
    for (const d of contactsSnap.docs) {
      await setDoc(doc(newDb, "contacts", d.id), d.data(), { merge: true });
      count++;
    }
    console.log(`   ✅ Migrated ${count} contacts successfully.`);
  } catch (err) {
    console.warn("   Contacts error:", err.message);
  }

  console.log("🎉 Migration finished cleanly!");
  process.exit(0);
}

runMigration().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
