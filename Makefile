CXX      = em++
CXXFLAGS = -std=c++17 -O3 -flto -I.

EM_FLAGS  = \
  -s EXPORTED_FUNCTIONS='["_wasm_init","_wasm_getBestMove","_wasm_wasBookMove","_wasm_getLegalMoves","_wasm_getScore","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAP32","HEAPU8","getValue","setValue"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s ENVIRONMENT=worker \
  -s EXPORT_NAME=createEngineModule \
  -s MODULARIZE=1

OUT_DIR = public
SRCS    = wasm_api.cpp

.PHONY: wasm serve clean

## Build WebAssembly engine (requires Emscripten SDK active)
wasm:
	$(CXX) $(CXXFLAGS) $(EM_FLAGS) $(SRCS) -o $(OUT_DIR)/engine.js

## Local dev server (requires Python 3)
serve:
	python3 -m http.server 8000

clean:
	rm -f $(OUT_DIR)/engine.js $(OUT_DIR)/engine.wasm
