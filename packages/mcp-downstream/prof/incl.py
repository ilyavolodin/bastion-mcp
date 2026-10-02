import json,sys,collections
d=json.load(open(sys.argv[1]))
nodes={n['id']:n for n in d['nodes']}
selft=collections.Counter()
for s,t in zip(d['samples'],d['timeDeltas']): selft[s]+=t
def incl(nid,memo={}):
    if nid in memo: return memo[nid]
    n=nodes[nid]; t=selft[nid]
    for c in n.get('children',[]): t+=incl(c)
    memo[nid]=t; return t
agg=collections.Counter(); seen=set()
# inclusive per function (avoid double count on recursion: count only outermost occurrence along path)
def walk(nid,stack):
    n=nodes[nid]; cf=n['callFrame']; key=(cf['functionName'] or '(anon)', cf['url'].split('/')[-1][:40], cf['lineNumber'])
    if key not in stack:
        agg[key]+=incl(nid)
    for c in n.get('children',[]): walk(c, stack|{key})
sys.setrecursionlimit(10000)
walk(d['nodes'][0]['id'],frozenset())
want=sys.argv[2:]
for k,v in agg.most_common(400):
    if not want or any(w in k[0] or w in k[1] for w in want):
        print(round(v/1000,1),'ms',k)
