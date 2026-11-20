/* ============ PENGATURAN ============ */
window.VG_CONFIG = {
  // API key dan folder Google Drive TIDAK ditulis di sini lagi.
  // Setiap pengunjung memasukkan miliknya sendiri lewat menu Profile, dan disimpan di browser masing-masing.
  // (Opsional, khusus pemilik: isi di bawah sebagai bawaan untuk browser yang belum pernah mengisi Profile.
  //  Hati-hati: apa pun yang ditulis di sini bisa dilihat siapa saja yang membuka website.)
  API_KEYS: [],
  FOLDERS: [],

  // Player bawaan untuk browser yang belum memilih di Profile -> Video player.
  // true  = "Smooth": player buatan sendiri (tombol bisa disembunyikan, ketuk 2x = loncat 10 detik). MEMAKAI sedikit kuota API.
  // false = "Google Drive": player bawaan Google (tanpa kuota, tampilannya tidak bisa diatur).
  // Menu Shorts selalu memakai kuota; Shorts (Offline) tidak.
  DIRECT_PLAY: true,

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