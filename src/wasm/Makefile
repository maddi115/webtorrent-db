EMCC = emcc
EMFLAGS = -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
          -s ALLOW_MEMORY_GROWTH=1 -s EXPORT_NAME="createModule" \
          --bind -s ENVIRONMENT=web

METADATA_SRC = metadata/crdt.cpp
METADATA_OUT = ../wasm-dist/crdt.mjs

HASH_SRC = hashing/hash.cpp
HASH_OUT = ../wasm-dist/hash.mjs

SERIALIZER_SRC = serialization/serializer.cpp
SERIALIZER_OUT = ../wasm-dist/serializer.mjs
SERIALIZER_FLAGS = -I/usr/local/include

all: crdt hash serializer

crdt:
	mkdir -p ../wasm-dist
	$(EMCC) $(EMFLAGS) $(METADATA_SRC) -o $(METADATA_OUT)

hash:
	mkdir -p ../wasm-dist
	$(EMCC) $(EMFLAGS) $(HASH_SRC) -o $(HASH_OUT)

serializer:
	mkdir -p ../wasm-dist
	$(EMCC) $(EMFLAGS) $(SERIALIZER_FLAGS) $(SERIALIZER_SRC) -o $(SERIALIZER_OUT)

clean:
	rm -rf ../wasm-dist

.PHONY: all crdt hash serializer clean
