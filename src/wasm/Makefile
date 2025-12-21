# Makefile for building WASM modules
# Requires Emscripten (emcc)

all:
	@echo "WASM build requires Emscripten"
	@echo "Install: https://emscripten.org/docs/getting_started/downloads.html"
	@echo "Then run: make build"

build:
	emcc metadata/crdt.cpp -o build/metadata.wasm -O3 -s WASM=1 -s MODULARIZE=1

clean:
	rm -f build/*.wasm
