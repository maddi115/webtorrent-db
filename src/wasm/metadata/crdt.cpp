#include <emscripten/bind.h>
#include <string>
#include <vector>
#include <map>
#include <algorithm>

using namespace emscripten;

struct Entry {
    std::string sourceURL;
    std::string magnet;
    std::string title;
    std::string addedBy;
    std::string preview;
    long long timestamp;
};

class CRDTMerger {
private:
    std::map<std::string, Entry> entries;
    
public:
    // Add or update entry (Last-Write-Wins)
    void addEntry(const std::string& sourceURL, const std::string& magnet, 
                  const std::string& title, const std::string& addedBy,
                  const std::string& preview, long long timestamp) {
        
        auto it = entries.find(sourceURL);
        
        // If entry doesn't exist or new one is newer, update
        if (it == entries.end() || timestamp > it->second.timestamp) {
            Entry entry;
            entry.sourceURL = sourceURL;
            entry.magnet = magnet;
            entry.title = title;
            entry.addedBy = addedBy;
            entry.preview = preview;
            entry.timestamp = timestamp;
            
            entries[sourceURL] = entry;
        }
    }
    
    // Merge two CRDT states (LWW conflict resolution)
    void mergeEntries(const CRDTMerger& other) {
        for (const auto& pair : other.entries) {
            const Entry& otherEntry = pair.second;
            addEntry(otherEntry.sourceURL, otherEntry.magnet, otherEntry.title,
                    otherEntry.addedBy, otherEntry.preview, otherEntry.timestamp);
        }
    }
    
    // Get entry by URL
    std::string getEntry(const std::string& sourceURL) const {
        auto it = entries.find(sourceURL);
        if (it != entries.end()) {
            const Entry& e = it->second;
            return e.sourceURL + "|" + e.magnet + "|" + e.title + "|" + 
                   e.addedBy + "|" + std::to_string(e.timestamp);
        }
        return "";
    }
    
    // Get all entries count
    int getCount() const {
        return entries.size();
    }
    
    // Check if entry exists
    bool hasEntry(const std::string& sourceURL) const {
        return entries.find(sourceURL) != entries.end();
    }
    
    // Get timestamp for entry
    long long getTimestamp(const std::string& sourceURL) const {
        auto it = entries.find(sourceURL);
        if (it != entries.end()) {
            return it->second.timestamp;
        }
        return 0;
    }
};

EMSCRIPTEN_BINDINGS(crdt_module) {
    class_<CRDTMerger>("CRDTMerger")
        .constructor<>()
        .function("addEntry", &CRDTMerger::addEntry)
        .function("mergeEntries", &CRDTMerger::mergeEntries)
        .function("getEntry", &CRDTMerger::getEntry)
        .function("getCount", &CRDTMerger::getCount)
        .function("hasEntry", &CRDTMerger::hasEntry)
        .function("getTimestamp", &CRDTMerger::getTimestamp);
}
