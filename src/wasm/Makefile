EMCC = emcc
EMFLAGS = -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
          -s ALLOW_MEMORY_GROWTH=1 -s EXPORT_NAME="createModule" \
          --bind -s ENVIRONMENT=web

METADATA_SRC = metadata/crdt.cpp
METADATA_OUT = ../wasm-dist/crdt.mjs

HASH_SRC = hashing/hash.cpp
HASH_OUT = ../wasm-dist/hash.mjs

all: crdt hash

crdt:
	mkdir -p ../wasm-dist
	$(EMCC) $(EMFLAGS) $(METADATA_SRC) -o $(METADATA_OUT)

hash:
	mkdir -p ../wasm-dist
	$(EMCC) $(EMFLAGS) $(HASH_SRC) -o $(HASH_OUT)

clean:
	rm -rf ../wasm-dist

.PHONY: all crdt hash clean
