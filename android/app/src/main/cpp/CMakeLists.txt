# Native code for the Android app — TASK-049.
#
# Two libraries, both linked against nodejs-mobile's libnode.so:
#
#   native-lib       the JNI bridge that starts Node on its own thread (native-lib.cpp)
#   better_sqlite3   better-sqlite3's addon, compiled here from the package's own source,
#                    because an addon has to be built for the tablet's CPU against the Node
#                    the app embeds. The server loads it through AGRIVET_SQLITE_ADDON
#                    (src/config/sqlite.js).
#
# LIBNODE_DIR and BETTER_SQLITE3_DIR come from app/build.gradle.kts.

cmake_minimum_required(VERSION 3.22.1)
project(chachi_pos LANGUAGES C CXX)

if(NOT EXISTS "${LIBNODE_DIR}/include/node/node.h")
  message(FATAL_ERROR "The Node runtime is not in ${LIBNODE_DIR}. Gradle downloads it on the "
    "first sync; if that failed, check the connection and sync again (android/README.md).")
endif()
if(NOT EXISTS "${BETTER_SQLITE3_DIR}/src/better_sqlite3.cpp")
  message(FATAL_ERROR "better-sqlite3's source is not in ${BETTER_SQLITE3_DIR}. "
    "Run `npm install` in the repository root first (android/README.md).")
endif()

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
  IMPORTED_LOCATION "${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so")

# ── The JNI bridge ─────────────────────────────────────────────────────────────
add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE "${LIBNODE_DIR}/include/node")
target_compile_features(native-lib PRIVATE cxx_std_17)
target_link_libraries(native-lib libnode log)

# ── better-sqlite3 ─────────────────────────────────────────────────────────────
# SQLite itself, with exactly the options better-sqlite3's own build uses
# (deps/defines.gypi) — a store's database must behave the same on the tablet as on
# the PC, down to foreign keys being on by default.
add_library(sqlite3 STATIC "${BETTER_SQLITE3_DIR}/deps/sqlite3/sqlite3.c")
target_include_directories(sqlite3 PUBLIC "${BETTER_SQLITE3_DIR}/deps/sqlite3")
set_target_properties(sqlite3 PROPERTIES POSITION_INDEPENDENT_CODE ON C_STANDARD 99)
target_compile_options(sqlite3 PRIVATE -w -O3)
target_compile_definitions(sqlite3 PUBLIC
  HAVE_INT16_T=1 HAVE_INT32_T=1 HAVE_INT8_T=1 HAVE_STDINT_H=1
  HAVE_UINT16_T=1 HAVE_UINT32_T=1 HAVE_UINT8_T=1 HAVE_USLEEP=1
  SQLITE_DEFAULT_CACHE_SIZE=-16000 SQLITE_DEFAULT_FOREIGN_KEYS=1 SQLITE_DEFAULT_MEMSTATUS=0
  SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 SQLITE_DQS=0 SQLITE_ENABLE_COLUMN_METADATA
  SQLITE_ENABLE_DBSTAT_VTAB SQLITE_ENABLE_DESERIALIZE SQLITE_ENABLE_FTS3
  SQLITE_ENABLE_FTS3_PARENTHESIS SQLITE_ENABLE_FTS4 SQLITE_ENABLE_FTS5 SQLITE_ENABLE_GEOPOLY
  SQLITE_ENABLE_JSON1 SQLITE_ENABLE_MATH_FUNCTIONS SQLITE_ENABLE_RTREE SQLITE_ENABLE_STAT4
  SQLITE_ENABLE_UPDATE_DELETE_LIMIT SQLITE_LIKE_DOESNT_MATCH_BLOBS SQLITE_OMIT_DEPRECATED
  SQLITE_OMIT_PROGRESS_CALLBACK SQLITE_OMIT_SHARED_CACHE SQLITE_OMIT_TCL_VARIABLE
  SQLITE_SOUNDEX SQLITE_THREADSAFE=2 SQLITE_TRACE_SIZE_LIMIT=32 SQLITE_USE_URI=0
  NDEBUG)

# The addon. Its V8 settings have to match the runtime's (include/node/config.gypi):
# nodejs-mobile builds without pointer compression, so V8_COMPRESS_POINTERS is not
# defined — defining it would make every object the addon touches the wrong size.
add_library(better_sqlite3 SHARED "${BETTER_SQLITE3_DIR}/src/better_sqlite3.cpp")
target_include_directories(better_sqlite3 PRIVATE "${LIBNODE_DIR}/include/node")
target_compile_features(better_sqlite3 PRIVATE cxx_std_20)
target_compile_options(better_sqlite3 PRIVATE -O3 -fno-rtti -Wno-deprecated-declarations)
target_compile_definitions(better_sqlite3 PRIVATE
  NODE_GYP_MODULE_NAME=better_sqlite3 BUILDING_NODE_EXTENSION USING_UV_SHARED=1
  USING_V8_SHARED=1 V8_DEPRECATION_WARNINGS=1 _LARGEFILE_SOURCE _FILE_OFFSET_BITS=64 NDEBUG)
target_link_libraries(better_sqlite3 sqlite3 libnode)
target_link_options(better_sqlite3 PRIVATE -Wl,-Bsymbolic -Wl,--exclude-libs,ALL)
