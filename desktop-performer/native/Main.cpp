#include <JuceHeader.h>
#include <iostream>
#include <thread>
#include <cmath>
#include <atomic>
#include <csignal>
#if JUCE_WINDOWS
 #include <io.h>
#else
 #include <unistd.h>
 #include <fcntl.h>
#endif
using namespace juce;

// Electron passes the PCM transport as inherited descriptor 3 (a pipe on macOS, a
// CRT-inherited named pipe on Windows). It is written only by the transport thread.
static constexpr int transportFd = 3;
static long writeTransport(const char* data, size_t size) {
#if JUCE_WINDOWS
    return _write(transportFd, data, (unsigned int) jmin(size, (size_t) 1 << 20));
#else
    return (long) ::write(transportFd, data, size);
#endif
}

static var object(std::initializer_list<std::pair<String,var>> fields) {
    auto* o = new DynamicObject(); for (auto& f: fields) o->setProperty(f.first,f.second); return var(o);
}
static void emit(var v) { std::cout << JSON::toString(v, true) << std::endl; }

// The audio callback only writes into a fixed-size, single producer/consumer FIFO.
// Neither the renderer nor a blocked network connection can block local monitoring.
struct AudioPipe {
    static constexpr int capacity = 131072;
    AbstractFifo fifo { capacity };
    std::array<float, capacity * 2> data {};
    std::atomic<int> dropped {0};
    std::atomic<double> rate {48000};
    void push(const AudioBuffer<float>& b) {
        int a,n,c,m; fifo.prepareToWrite(b.getNumSamples(),a,n,c,m);
        auto copy=[&](int start,int count,int offset) {
            for(int i=0;i<count;++i) for(int ch=0;ch<2;++ch)
                data[(start+i)*2+ch]=b.getSample(ch,offset+i);
        };
        copy(a,n,0); copy(c,m,n); fifo.finishedWrite(n+m);
        if(n+m < b.getNumSamples()) ++dropped;
    }
};

class Strip final: public AudioProcessor {
public:
    enum Kind { Gain, Mic, Master };
    Kind kind; AudioPipe* pipe;
    std::atomic<float> level {1}, peak {0}, peakL {0}, peakR {0}, pan {0};
    std::atomic<bool> solo {false}; std::atomic<bool>* anySolo=nullptr;
    std::atomic<bool> muted {false};
    std::atomic<int> input {0};
    std::atomic<float> monitor {0}; // Monitoring is opt-in to avoid open-mic feedback.
    float previous=0, previousMonitor=0, previousL=1, previousR=1;
    Strip(Kind k=Gain,AudioPipe* p=nullptr): AudioProcessor(BusesProperties().withInput("In",AudioChannelSet::stereo(),true).withOutput("Out",AudioChannelSet::stereo(),true)),kind(k),pipe(p) {}
    const String getName() const override {return "Mixer";}
    void prepareToPlay(double rate,int) override {previous=0;previousMonitor=0;previousL=jmin(1.0f,1.0f-pan.load());previousR=jmin(1.0f,1.0f+pan.load());if(pipe)pipe->rate=rate;}
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout& l) const override {return l.getMainInputChannelSet()==AudioChannelSet::stereo() && l.getMainOutputChannelSet()==AudioChannelSet::stereo();}
    void processBlock(AudioBuffer<float>& b,MidiBuffer&) override {
        ScopedNoDenormals noDenormals;
        // A plug-in emitting NaN/Inf would otherwise latch downstream plug-in state
        // (compressor envelopes, reverb tanks) and silence the master until relaunch.
        for(int ch=0;ch<b.getNumChannels();++ch){auto* d=b.getWritePointer(ch);for(int i=0;i<b.getNumSamples();++i)if(!std::isfinite(d[i]))d[i]=0;}
        if(kind==Mic) b.copyFrom(1-input.load(),0,b,input.load(),0,b.getNumSamples());
        float target=(muted||(anySolo&&anySolo->load()&&!solo.load()))?0.0f:level.load();
        b.applyGainRamp(0,b.getNumSamples(),previous,target);previous=target;
        float balance=pan.load(),left=jmin(1.0f,1.0f-balance),right=jmin(1.0f,1.0f+balance);
        b.applyGainRamp(0,0,b.getNumSamples(),previousL,left);b.applyGainRamp(1,0,b.getNumSamples(),previousR,right);previousL=left;previousR=right;
        peakL=b.getMagnitude(0,0,b.getNumSamples());peakR=b.getMagnitude(1,0,b.getNumSamples());peak=jmax(peakL.load(),peakR.load());
        if(kind==Master) {
            // Broadcast feed is before the independent headphone gain.
            if(pipe)pipe->push(b);
            float mon=monitor.load();b.applyGainRamp(0,b.getNumSamples(),previousMonitor,mon);previousMonitor=mon;
        }
    }
    bool acceptsMidi() const override{return false;} bool producesMidi()const override{return false;}
    double getTailLengthSeconds()const override{return 0;}
    bool hasEditor()const override{return false;} AudioProcessorEditor* createEditor()override{return nullptr;}
    int getNumPrograms()override{return 1;}int getCurrentProgram()override{return 0;}
    void setCurrentProgram(int)override{}const String getProgramName(int)override{return {};}
    void changeProgramName(int,const String&)override{}
    void getStateInformation(MemoryBlock&)override{}void setStateInformation(const void*,int)override{}
};
class EditorWindow: public DocumentWindow {
public:
    EditorWindow(AudioPluginInstance& p):DocumentWindow(p.getName(),Colour(0xff171a23),DocumentWindow::closeButton) {
        setUsingNativeTitleBar(true); setContentOwned(p.createEditorIfNeeded(),true);
        if(!getContentComponent())setContentOwned(new GenericAudioProcessorEditor(p),true);
        setResizable(true,false);centreWithSize(getWidth(),getHeight());setVisible(true);
    }
    void showEditor() {
        // The mixer and this window live in different processes. Ordering the
        // NSWindow alone does not activate the LSUIElement audio helper.
        Process::makeForegroundProcess();
        setVisible(true);
        setMinimised(false);
        toFront(true);
        if (auto* content = getContentComponent()) content->grabKeyboardFocus();
    }
    void closeButtonPressed()override{setVisible(false);}
};

class Engine: public Timer,public MidiInputCallback {
public:
    AudioDeviceManager devices; AudioProcessorPlayer player; AudioProcessorGraph graph;
    AudioPluginFormatManager formats; AudioPipe pipe;
    using Node=AudioProcessorGraph::Node::Ptr; using ID=AudioProcessorGraph::NodeID;
    Node audioIn,audioOut,midiIn;
    std::map<String,Node> strips,slots;
    std::map<String,PluginDescription> descriptions;
    std::map<String,std::unique_ptr<EditorWindow>> editors;
    std::atomic<bool> running {false},anySolo {false};
    String midiId; var deviceConfig=object({});
    CriticalSection midiLock; Array<var> midiEvents;
    std::vector<char> pending; size_t pendingOffset=0;
    uint32_t sequence=0; int ticks=0;std::atomic<bool> transportStop{false};std::thread transportThread;
    Engine() {
        addDefaultFormatsToManager(formats);
        graph.setPlayConfigDetails(2,2,48000,256);
        using IO=AudioProcessorGraph::AudioGraphIOProcessor;
        audioIn=graph.addNode(std::make_unique<IO>(IO::audioInputNode));
        audioOut=graph.addNode(std::make_unique<IO>(IO::audioOutputNode));
        midiIn=graph.addNode(std::make_unique<IO>(IO::midiInputNode));
        for(auto name:{"piano","mic","aux1","aux2","pianoSend1","pianoSend2","micSend1","micSend2","master"}) {
            auto k=String(name)=="mic"?Strip::Mic:String(name)=="master"?Strip::Master:Strip::Gain;
            strips[name]=graph.addNode(std::make_unique<Strip>(k,k==Strip::Master?&pipe:nullptr));
            if(String(name).contains("Send")) strip(name).level=0;
        }
        strip("piano").anySolo=&anySolo;strip("mic").anySolo=&anySolo;
        reconnect();
       #if ! JUCE_WINDOWS
        int flags=fcntl(transportFd,F_GETFL,0);if(flags>=0)fcntl(transportFd,F_SETFL,flags|O_NONBLOCK);
       #endif // Windows pipe writes block, but only on the transport thread; the FIFO absorbs it.
        transportThread=std::thread([this]{while(!transportStop){pumpAudio();std::this_thread::sleep_for(std::chrono::milliseconds(5));}});
        startTimer(20);
    }
    ~Engine()override {stopTimer();stop();transportStop=true;if(transportThread.joinable())transportThread.join();editors.clear();player.setProcessor(nullptr);}
    Strip& strip(const String& s){return *static_cast<Strip*>(strips.at(s)->getProcessor());}
    // Connections are batched (UpdateKind::none) and the graph is rebuilt once, so the
    // audio thread never sees a half-wired graph.
    void connect(Node a,Node b) {for(int ch=0;ch<2;++ch)if(!graph.addConnection({{a->nodeID,ch},{b->nodeID,ch}},AudioProcessorGraph::UpdateKind::none))throw std::runtime_error("Invalid stereo connection");}
    // The device may expose 0, 1 or 2 inputs (No input, a mono built-in mic, an interface).
    // A fixed stereo connection fails on the first two, which used to abort reconnect()
    // part-way and leave the whole mixer disconnected until relaunch.
    void connectInput(Node dest) {
        auto* io=static_cast<AudioProcessorGraph::AudioGraphIOProcessor*>(audioIn->getProcessor());io->setParentGraph(&graph);
        int available=jmin(2,io->getTotalNumOutputChannels());if(available==0)return;
        for(int ch=0;ch<2;++ch)graph.addConnection({{audioIn->nodeID,jmin(ch,available-1)},{dest->nodeID,ch}},AudioProcessorGraph::UpdateKind::none);
    }
    Node chain(Node source,const String& prefix) {
        for(int i=0;i<2;++i){auto key=prefix+String(i);if(slots.count(key)){connect(source,slots[key]);source=slots[key];}}return source;
    }
    void reconnect() {
        for(auto c:graph.getConnections())graph.removeConnection(c,AudioProcessorGraph::UpdateKind::none);
        if(slots.count("instrument")) {
            graph.addConnection({{midiIn->nodeID,AudioProcessorGraph::midiChannelIndex},{slots["instrument"]->nodeID,AudioProcessorGraph::midiChannelIndex}},AudioProcessorGraph::UpdateKind::none);
            connect(chain(slots["instrument"],"piano"),strips["piano"]);
        }
        // Mono selection must precede the microphone inserts.
        if(!strips.count("micInput"))strips["micInput"]=graph.addNode(std::make_unique<Strip>(Strip::Mic));
        strip("mic").kind=Strip::Gain;
        connectInput(strips["micInput"]);connect(chain(strips["micInput"],"mic"),strips["mic"]);
        Node sum;
        if(!strips.count("sum"))strips["sum"]=graph.addNode(std::make_unique<Strip>());
        sum=strips["sum"];
        for(auto name:{"piano","mic"}) {
            connect(strips[name],sum);
            for(int i=1;i<=2;++i){String send=String(name)+"Send"+String(i);connect(strips[name],strips[send]);}
        }
        for(int i=1;i<=2;++i){String aux="aux"+String(i);
            if(!strips.count(aux+"Sum"))strips[aux+"Sum"]=graph.addNode(std::make_unique<Strip>());
            connect(strips["pianoSend"+String(i)],strips[aux+"Sum"]);connect(strips["micSend"+String(i)],strips[aux+"Sum"]);
            // Empty aux returns must not double the dry signal.
            if(slots.count(aux+"0")||slots.count(aux+"1"))connect(chain(strips[aux+"Sum"],aux),strips[aux]);
            connect(strips[aux],sum);
        }
        connect(chain(sum,"master"),strips["master"]);connect(strips["master"],audioOut);
        graph.rebuild();
    }
    void stop(){if(running){devices.removeMidiInputDeviceCallback({},this);devices.removeMidiInputDeviceCallback({},&player);devices.removeAudioCallback(&player);running=false;}devices.closeAudioDevice();}
    void start(var config) {
        stop(); strip("master").monitor=0;
        bool noInput=config["input"].toString()=="__none__";
        auto err=devices.initialise(noInput?0:2,2,nullptr,true);if(err.isNotEmpty())throw std::runtime_error(err.toStdString());
        auto type=config["type"].toString();
        if(type.isNotEmpty()&&type!=devices.getCurrentAudioDeviceType()){
            bool known=false;for(auto* t:devices.getAvailableDeviceTypes())known|=t->getTypeName()==type;
            if(!known)throw std::runtime_error(("Audio driver not available: "+type).toStdString());
            devices.setCurrentAudioDeviceType(type,true);
        }
        AudioDeviceManager::AudioDeviceSetup setup;devices.getAudioDeviceSetup(setup);
        auto in=config["input"].toString(),out=config["output"].toString();
        if(out.isNotEmpty())setup.outputDeviceName=out;
        if(noInput){setup.inputDeviceName="";setup.useDefaultInputChannels=false;setup.inputChannels.clear();}
        else if(in.isNotEmpty())setup.inputDeviceName=in;
        if((double)config["rate"]>0)setup.sampleRate=(double)config["rate"];
        if((int)config["buffer"]>0)setup.bufferSize=(int)config["buffer"];
        err=devices.setAudioDeviceSetup(setup,true);if(err.isNotEmpty()){devices.closeAudioDevice();throw std::runtime_error(err.toStdString());}
        deviceConfig=object({{"type",devices.getCurrentAudioDeviceType()},{"input",noInput?String("__none__"):setup.inputDeviceName},{"output",setup.outputDeviceName},{"rate",setup.sampleRate},{"buffer",setup.bufferSize}});
        player.setProcessor(&graph); devices.addAudioCallback(&player);running=true;
        reconnect(); // The input channel count may differ from the previous device.
        devices.addMidiInputDeviceCallback({},&player);devices.addMidiInputDeviceCallback({},this);
        selectMidi(midiId);
    }
    void selectMidi(String id){midiId=id;for(auto d:MidiInput::getAvailableDevices())devices.setMidiInputDeviceEnabled(d.identifier,id.isEmpty()||id==d.identifier);}
    void handleIncomingMidiMessage(MidiInput*,const MidiMessage& m)override {
        if(m.getRawDataSize()>3)return;
        const ScopedLock lock(midiLock);if(midiEvents.size()>2048)return;
        Array<var> bytes;for(int i=0;i<m.getRawDataSize();++i)bytes.add((int)m.getRawData()[i]);midiEvents.add(var(bytes));
    }
    var deviceList() {
        Array<var> types;
        for(auto* t:devices.getAvailableDeviceTypes()){
            t->scanForDevices();Array<var> ins,outs;
            for(auto s:t->getDeviceNames(true))ins.add(s);for(auto s:t->getDeviceNames(false))outs.add(s);
            types.add(object({{"name",t->getTypeName()},{"inputs",ins},{"outputs",outs}}));
        }
        Array<var> midi;for(auto d:MidiInput::getAvailableDevices())midi.add(object({{"id",d.identifier},{"name",d.name}}));
        return object({{"types",types},{"midi",midi}});
    }
    void load(const String& key,const String& path,const String& state={}) {
        const StringArray valid {"instrument","piano0","piano1","mic0","mic1","aux10","aux11","aux20","aux21","master0","master1"};
        if(!valid.contains(key))throw std::runtime_error("Unknown insert slot");
        bool active=running;if(active)devices.removeAudioCallback(&player);
        auto resume=ScopeGuard{[&]{if(active)devices.addAudioCallback(&player);}};
        if(path.isEmpty()){editors.erase(key);if(slots.count(key))graph.removeNode(slots[key]->nodeID);slots.erase(key);descriptions.erase(key);reconnect();return;}
        OwnedArray<PluginDescription> found;
        for(auto* f:formats.getFormats())if(f->fileMightContainThisPluginType(path))f->findAllTypesForFile(found,path);
        if(found.isEmpty())throw std::runtime_error("No compatible plug-in found");
        auto desc=*found[0];String error;
        auto* dev=devices.getCurrentAudioDevice();
        auto p=formats.createPluginInstance(desc,dev?dev->getCurrentSampleRate():48000,dev?dev->getCurrentBufferSizeSamples():256,error);
        if(!p)throw std::runtime_error(error.toStdString());
        p->enableAllBuses();
        auto layout=p->getBusesLayout();
        for(int i=1;i<layout.inputBuses.size();++i)layout.inputBuses.getReference(i)=AudioChannelSet::disabled();
        for(int i=1;i<layout.outputBuses.size();++i)layout.outputBuses.getReference(i)=AudioChannelSet::disabled();
        if(!layout.inputBuses.isEmpty())layout.inputBuses.getReference(0)=key=="instrument"?AudioChannelSet::disabled():AudioChannelSet::stereo();
        if(!layout.outputBuses.isEmpty())layout.outputBuses.getReference(0)=AudioChannelSet::stereo();
        if(!p->setBusesLayout(layout)||p->getTotalNumOutputChannels()!=2||(key!="instrument"&&p->getTotalNumInputChannels()!=2))throw std::runtime_error("This slot requires a stereo plug-in layout");
        if(key!="instrument"&&desc.isInstrument)throw std::runtime_error("Choose an effect, not an instrument, for this insert");
        if(key=="instrument"&&!p->acceptsMidi())throw std::runtime_error("Choose a MIDI instrument for the Pianoteq slot");
        if(state.isNotEmpty()){MemoryBlock b;if(!b.fromBase64Encoding(state))throw std::runtime_error("Invalid plug-in state");p->setStateInformation(b.getData(),(int)b.getSize());}
        editors.erase(key);if(slots.count(key))graph.removeNode(slots[key]->nodeID);
        slots[key]=graph.addNode(std::move(p));descriptions[key]=desc;reconnect();
    }
    var save() {
        Array<var> plugins;for(auto& s:slots){MemoryBlock b;s.second->getProcessor()->getStateInformation(b);plugins.add(object({{"slot",s.first},{"path",descriptions[s.first].fileOrIdentifier},{"state",b.toBase64Encoding()},{"bypass",s.second->isBypassed()}}));}
        auto* mix=new DynamicObject();for(auto& s:strips)mix->setProperty(s.first,object({{"gain",strip(s.first).level.load()},{"mute",strip(s.first).muted.load()},{"pan",strip(s.first).pan.load()},{"solo",strip(s.first).solo.load()}}));
        String xml;if(auto x=devices.createStateXml())xml=x->toString();
        return object({{"version",1},{"plugins",plugins},{"mix",var(mix)},{"deviceXml",xml},{"deviceConfig",deviceConfig},{"midi",midiId},{"micInput",strip("micInput").input.load()}});
    }
    var status() {
        auto* values=new DynamicObject();for(auto& s:strips)values->setProperty(s.first,object({{"gain",strip(s.first).level.load()},{"mute",strip(s.first).muted.load()},{"pan",strip(s.first).pan.load()},{"solo",strip(s.first).solo.load()},{"peak",strip(s.first).peak.load()},{"peakL",strip(s.first).peakL.load()},{"peakR",strip(s.first).peakR.load()}}));
        auto* plugs=new DynamicObject();for(auto& s:descriptions)plugs->setProperty(s.first,object({{"name",s.second.name},{"path",s.second.fileOrIdentifier},{"bypass",slots[s.first]->isBypassed()},{"latency",slots[s.first]->getProcessor()->getLatencySamples()}}));
        auto* d=devices.getCurrentAudioDevice();
        return object({{"running",running.load()&&d&&d->isPlaying()},{"mix",var(values)},{"plugins",var(plugs)},{"rate",d?d->getCurrentSampleRate():0},{"buffer",d?d->getCurrentBufferSizeSamples():0},{"output",d?d->getName():String()},{"type",devices.getCurrentAudioDeviceType()},{"dropped",pipe.dropped.load()},{"monitor",strip("master").monitor.load()},{"latency",graph.getLatencySamples()},{"deviceConfig",deviceConfig},{"midi",midiId},{"micInput",strip("micInput").input.load()}});
    }
    var command(var c) {
        auto op=c["op"].toString();
        if(op=="devices")return deviceList();
        if(op=="start")start(c);
        else if(op=="stop")stop();
        else if(op=="load")load(c["slot"],c["path"]);
        else if(op=="editor") {String k=c["slot"];if(!slots.count(k))throw std::runtime_error("Slot is empty");if(!editors.count(k))editors[k]=std::make_unique<EditorWindow>(*dynamic_cast<AudioPluginInstance*>(slots[k]->getProcessor()));editors[k]->showEditor();}
        else if(op=="gain"||op=="mute") {String k=c["strip"];if(!strips.count(k))throw std::runtime_error("Unknown strip");if(op=="gain")strip(k).level=jlimit(0.0f,2.0f,(float)c["value"]);else strip(k).muted=(bool)c["value"];}
        else if(op=="bypass"){String k=c["slot"];if(!slots.count(k))throw std::runtime_error("Slot is empty");slots[k]->setBypassed((bool)c["value"]);}
        else if(op=="pan"){String k=c["strip"];if(!strips.count(k))throw std::runtime_error("Unknown strip");strip(k).pan=jlimit(-1.0f,1.0f,(float)c["value"]);}
        else if(op=="solo"){String k=c["strip"];if(k!="piano"&&k!="mic")throw std::runtime_error("Only input channels can be soloed");strip(k).solo=(bool)c["value"];anySolo=strip("piano").solo.load()||strip("mic").solo.load();}
        else if(op=="monitor")strip("master").monitor=jlimit(0.0f,1.0f,(float)c["value"]);
        else if(op=="input")strip("micInput").input=jlimit(0,1,(int)c["value"]);
        else if(op=="midiDevice")selectMidi(c["identifier"]);
        else if(op=="midi") {auto* a=c["bytes"].getArray();if(a&&a->size()>=2&&a->size()<=3){uint8_t b[3]{};for(int i=0;i<a->size();++i)b[i]=(uint8_t)(int)(*a)[i];MidiMessage m(b,a->size(),Time::getMillisecondCounterHiRes()/1000.0);player.getMidiMessageCollector().addMessageToQueue(m);}}
        else if(op=="panic")for(int ch=1;ch<=16;++ch){auto m=MidiMessage::allSoundOff(ch);m.setTimeStamp(Time::getMillisecondCounterHiRes()/1000.0);player.getMidiMessageCollector().addMessageToQueue(m);}
        else if(op=="renderTest") {
            if(running)throw std::runtime_error("Stop hardware audio before offline verification");
            graph.setPlayConfigDetails(2,2,48000,256);graph.prepareToPlay(48000,256);
            AudioBuffer<float> buffer(2,256);MidiBuffer midi;float peak=0,leftPeak=0,rightPeak=0,auxPeak=0;
            for(int block=0;block<188;++block){buffer.clear();if((bool)c["inputTone"])for(int sample=0;sample<256;++sample){float tone=0.1f*std::sin(MathConstants<double>::twoPi*440.0*(block*256+sample)/48000.0);buffer.setSample(0,sample,tone);buffer.setSample(1,sample,tone);}
                midi.clear();if(block==0&&!(bool)c["inputTone"])midi.addEvent(MidiMessage::noteOn(1,60,(uint8)100),0);if(block==150)midi.addEvent(MidiMessage::noteOff(1,60),0);graph.processBlock(buffer,midi);peak=jmax(peak,strip("master").peak.load());leftPeak=jmax(leftPeak,strip("master").peakL.load());rightPeak=jmax(rightPeak,strip("master").peakR.load());auxPeak=jmax(auxPeak,strip("aux1").peak.load());}
            // The master meter measures the stream before muted monitoring.
            graph.releaseResources();
            return object({{"frames",188*256},{"peak",peak},{"leftPeak",leftPeak},{"rightPeak",rightPeak},{"auxPeak",auxPeak},{"latency",graph.getLatencySamples()},{"deviceConfig",deviceConfig}});
        }
        else if(op=="save") {bool active=running;if(active)devices.removeAudioCallback(&player);auto resume=ScopeGuard{[&]{if(active)devices.addAudioCallback(&player);}};return save();}
        else if(op=="restore") {
            auto s=c["session"];if((int)s["version"]!=1)throw std::runtime_error("Unsupported session version");
            stop();strip("master").monitor=0;
            editors.clear();for(auto& entry:slots)graph.removeNode(entry.second->nodeID);slots.clear();descriptions.clear();reconnect();
            if(auto* ps=s["plugins"].getArray())for(auto p:*ps){load(p["slot"],p["path"],p["state"]);slots[p["slot"].toString()]->setBypassed((bool)p["bypass"]);}
            if(auto* mix=s["mix"].getDynamicObject())for(auto& item:mix->getProperties())if(strips.count(item.name.toString())){auto& st=strip(item.name.toString());st.level=jlimit(0.0f,2.0f,(float)item.value["gain"]);st.muted=(bool)item.value["mute"];st.pan=jlimit(-1.0f,1.0f,(float)item.value["pan"]);st.solo=(bool)item.value["solo"];}
            anySolo=strip("piano").solo.load()||strip("mic").solo.load();strip("micInput").input=jlimit(0,1,(int)s["micInput"]);midiId=s["midi"];
            // Restore device selection without starting capture or monitoring.
            deviceConfig=s["deviceConfig"];
        }
        else if(op!="status")throw std::runtime_error("Unknown engine command");
        return status();
    }
    void pumpAudio() {
        // Non-blocking pipe writes; retain partial frames until their next write.
        for(int batch=0;batch<4;++batch){
            if(pending.empty()) {
                int available=jmin(pipe.fifo.getNumReady(),2048);if(!available)break;
                pending.resize(16+available*8);uint32_t header[4]={0x50434d31,(uint32_t)pipe.rate.load(),(uint32_t)available,sequence++};memcpy(pending.data(),header,16);
                int a,n,c,m;pipe.fifo.prepareToRead(available,a,n,c,m);
                memcpy(pending.data()+16,pipe.data.data()+a*2,n*8);memcpy(pending.data()+16+n*8,pipe.data.data()+c*2,m*8);pipe.fifo.finishedRead(n+m);
            }
            auto written=writeTransport(pending.data()+pendingOffset,pending.size()-pendingOffset);
            if(written<=0)break;pendingOffset+=(size_t)written;
            if(pendingOffset==pending.size()){pending.clear();pendingOffset=0;}else break;
        }
    }
    void timerCallback()override {
        Array<var> events;{const ScopedLock lock(midiLock);events.swapWith(midiEvents);}if(!events.isEmpty())emit(object({{"event","midi"},{"messages",events}}));
        if(++ticks%10==0)emit(object({{"event","status"},{"data",status()}}));
    }
};
class Application:public JUCEApplication {
public:
    std::unique_ptr<Engine> engine;
    const String getApplicationName()override{return "Performer Audio Engine";}
    const String getApplicationVersion()override{return "0.1.0";}
    void initialise(const String&)override {
       #if ! JUCE_WINDOWS
        std::signal(SIGPIPE,SIG_IGN);
       #endif
        engine=std::make_unique<Engine>();emit(object({{"event","ready"}}));
        std::thread([this]{std::string line;while(std::getline(std::cin,line)){if(line.size()>32*1024*1024)continue;auto c=JSON::parse(String(line));MessageManager::callAsync([this,c]{if(!engine)return;try{emit(object({{"id",c["id"]},{"ok",true},{"data",engine->command(c)}}));}catch(const std::exception& e){emit(object({{"id",c["id"]},{"ok",false},{"error",String(e.what())}}));}});}MessageManager::callAsync([this]{quit();});}).detach();
    }
    void shutdown()override{engine.reset();}
};
START_JUCE_APPLICATION(Application)
