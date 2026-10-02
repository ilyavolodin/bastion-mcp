import json,sys,collections
f=sys.argv[1]
d=json.load(open(f))
nodes={n['id']:n for n in d['nodes']}
dt=d['timeDeltas']; samples=d['samples']
self_t=collections.Counter()
for s,t in zip(samples,dt): self_t[s]+=t
tot=sum(dt)
agg=collections.Counter(); aggfile=collections.Counter()
for nid,t in self_t.items():
    cf=nodes[nid]['callFrame']
    name=cf['functionName'] or '(anon)'
    path=cf['url'].replace('file:///C:/Users/ivolo/Documents/GitHub/bastion-mcp/','')
    agg[(name,path[-55:],cf['lineNumber'])]+=t
    aggfile[path[-70:]]+=t
print('total ms',tot/1000)
for k,v in agg.most_common(int(sys.argv[2]) if len(sys.argv)>2 else 30): print(round(v/1000,1),'ms',round(100*v/tot,1),'%',k)
print('--- by file')
for k,v in aggfile.most_common(20): print(round(v/1000,1),'ms',k)
