/* ============ PENGATURAN ============ */
window.VG_CONFIG = {
  // API key dan folder Google Drive TIDAK ditulis di sini lagi.
  // Setiap pengunjung memasukkan miliknya sendiri lewat menu Profile, dan disimpan di browser masing-masing.
  // (Opsional, khusus pemilik: isi di bawah sebagai bawaan untuk browser yang belum pernah mengisi Profile.
  //  Hati-hati: apa pun yang ditulis di sini bisa dilihat siapa saja yang membuka website.)
  API_KEYS: [],
  FOLDERS: [],

  // true = Home memutar video langsung (autoplay + loop) lewat API key -> MEMAKAI kuota Drive API.
  // false = player Google Drive biasa (tidak memakai kuota, tanpa loop otomatis).
  // Menu Shorts selalu memakai kuota; Shorts (Offline) tidak.
  DIRECT_PLAY: false,

  // Dimatikan: daftar video diambil langsung dari Drive pengunjung, bukan dari videos.json.
  VIDEOS_JSON: "",

  // Subfolder dengan nama ini (di dalam folder yang ditambahkan) otomatis masuk ke Favorites.
  // Subfolder lain otomatis jadi kategori (chip di atas).
  FAVORITE_FOLDER_NAMES: ["favorit", "favorite", "favorites", "favourite"],

  // Jumlah video yang dimuat setiap kali scroll ke bawah.
  PAGE_SIZE: 10,

  // Daftar video disimpan sementara di browser supaya buka ulang langsung tampil (menit).
  CACHE_MINUTES: 10
};