// timers.js - Performance benchmarking
export class Timer {
    constructor(label) {
        this.label = label;
        this.start = performance.now();
    }
    
    end() {
        const duration = performance.now() - this.start;
        console.log(`⏱️  ${this.label}: ${duration.toFixed(2)}ms`);
        return duration;
    }
}
