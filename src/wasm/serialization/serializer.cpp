#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include <vector>
#include "entry_generated.h"

using namespace emscripten;
using namespace WebTorrentDB;

// Serialize entry to binary
val serializeEntry(const std::string& sourceURL, const std::string& magnet,
                   const std::string& title, const std::string& addedBy,
                   const std::string& preview, int64_t timestamp) {
    
    flatbuffers::FlatBufferBuilder builder(1024);
    
    auto source_url_offset = builder.CreateString(sourceURL);
    auto magnet_offset = builder.CreateString(magnet);
    auto title_offset = builder.CreateString(title);
    auto added_by_offset = builder.CreateString(addedBy);
    auto preview_offset = builder.CreateString(preview);
    
    auto entry = CreateEntry(builder, source_url_offset, magnet_offset,
                            title_offset, added_by_offset, preview_offset,
                            timestamp);
    
    builder.Finish(entry);
    
    // Return as Uint8Array
    uint8_t* buf = builder.GetBufferPointer();
    int size = builder.GetSize();
    
    return val(typed_memory_view(size, buf));
}

// Deserialize binary to entry object
val deserializeEntry(const std::string& binaryData) {
    const uint8_t* buf = reinterpret_cast<const uint8_t*>(binaryData.data());
    
    auto entry = GetEntry(buf);
    
    // Create JS object
    val result = val::object();
    result.set("sourceURL", val(entry->source_url()->c_str()));
    result.set("magnet", val(entry->magnet()->c_str()));
    result.set("title", val(entry->title() ? entry->title()->c_str() : ""));
    result.set("addedBy", val(entry->added_by() ? entry->added_by()->c_str() : ""));
    result.set("preview", val(entry->preview() ? entry->preview()->c_str() : ""));
    result.set("timestamp", val(entry->timestamp()));
    
    return result;
}

// Get serialized size
int getSerializedSize(const std::string& binaryData) {
    return binaryData.size();
}

EMSCRIPTEN_BINDINGS(serializer_module) {
    function("serializeEntry", &serializeEntry);
    function("deserializeEntry", &deserializeEntry);
    function("getSerializedSize", &getSerializedSize);
}
