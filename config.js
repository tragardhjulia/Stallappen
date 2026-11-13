// Fylls i en gång av den som lägger upp appen (se README.md, steg 3).
window.CONFIG = {
  FARM: "Loddby Gård",
  SUPABASE_URL: "https://qmmltwcvjbvspalimart.supabase.co",        // t.ex. https://abcdxyz.supabase.co
  SUPABASE_ANON_KEY: "sb_publishable_HWrc7olXGg_9hUJHyEoUPA_PzBN5z8D",   // "anon"/"publishable"-nyckeln (den publika, inte service_role!)
  // Gårdens koordinater för väderkortet. Lämna null så visas inget väder.
  // Hitta dem genom att högerklicka på gården i Google Maps.
  LAT: null,
  LON: null
};
