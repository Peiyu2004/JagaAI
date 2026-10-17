"""Visible-attribute checks supplement semantic ranking; similarity is not proof."""
import re

COLOURS={
    'red':['red','红'], 'pink':['pink','粉红'], 'white':['white','白','putih'],
    'black':['black','黑','hitam'], 'blue':['blue','蓝','biru'],
    'green':['green','绿','hijau'], 'yellow':['yellow','黄','kuning'],
    'orange':['orange','橙','jingga'], 'brown':['brown','棕','coklat'],
    'grey':['grey','gray','灰','kelabu'], 'purple':['purple','紫','ungu'],
}
COLOURS['red'].append('merah')
OBJECTS={
    'person':r'\b(?:persons?|people|man|woman|men|women|someone|somebody|anyone|anybody|pedestrians?|humans?|individuals?|children|child|kids?|adults?|boys?|girls?|lelaki|wanita|orang|pejalan\s+kaki|kanak-kanak)\b|人|男子|女子|小孩',
    'vehicle':r'\b(?:vehicle|vehicles|kenderaan)\b|车辆',
    'car':r'\b(?:car|cars|suv|kereta)\b|汽车|轿车|白车|红车',
    'bus':r'\b(?:bus|coach|bas)\b|巴士|大巴',
    'truck':r'\b(?:truck|pickup|lorry|lori)\b|货车|卡车|皮卡',
    'bicycle':r'\b(?:bicycle|bike|basikal)\b|自行车|脚踏车',
    'elephant':r'\b(?:elephant|gajah)\b|大象',
    'dog':r'\b(?:dog|anjing)\b|狗',
    'door':r'\b(?:door|doorway|entrance|pintu)\b|门口|门',
    'stairs':r'\b(?:stairs|staircase|stairwell|tangga)\b|楼梯',
}


def constraints(query):
    text=query.casefold()
    people,vehicles,other=[],[],[]
    # Prevent 粉红 from also being parsed as 红.
    if '粉红' in text:
        text=text.replace('粉红','pink')
    for colour,aliases in COLOURS.items():
        mentioned=False
        for alias in aliases:
            term=re.escape(alias)
            token=term if re.search('[\u4e00-\u9fff]',alias) else rf'\b{term}\b'
            if not re.search(token,text):
                continue
            mentioned=True
            if re.search(rf'(?:wearing\s+(?:a\s+)?|\bin\s+(?:a\s+)?|(?:穿|身穿)){term}|{term}[- ](?:shirt|top|jacket|coat|clothes|clothing|sweater|hoodie|person)|{term}(?:色)?(?:的)?(?:上衣|衣服|衣|外套|衬衫)|baju\s+{term}',text):
                people.append(colour)
            elif re.search(rf'{term}\s+(?:(?:parked|parking)\s+)?(?:car|suv|truck|vehicle|bus)|{term}(?:色)?(?:的)?(?:汽车|轿车|车|货车|巴士)|(?:kereta|kenderaan|bas)\s+{term}',text):
                vehicles.append(colour)
            else:
                other.append(colour)
            break
    required=[name for name,pattern in OBJECTS.items() if re.search(pattern,text)]
    if people and 'person' not in required:
        required.append('person')
    if vehicles and not set(required)&{'car','bus','truck','vehicle','bicycle'}:
        required.append('vehicle')
    return {'person_colours':people,'vehicle_colours':vehicles,'other_colours':other,'objects':required}


def multilingual_attribute_query(query, requested):
    """Add a shared retrieval phrase for recognised Chinese/Malay colour and object conditions.

    The original query remains in ranking. This is a visible-attribute lead, not
    a translation or verification of every relationship/action in the question.
    """
    if not (re.search('[\u4e00-\u9fff]',query) or re.search(r'\b(?:baju|berbaju|kereta|orang|lelaki|wanita|kenderaan)\b',query.casefold())):
        return None
    if requested['other_colours']:
        return None
    subjects=[]
    kind=next((k for k in ('car','truck','bus','bicycle','vehicle') if k in requested['objects']),None)
    if requested['person_colours']:
        subjects.append('person wearing '+' and '.join(requested['person_colours']))
    elif 'person' in requested['objects']:
        # Object-only questions (有人吗, ada orang) get the same shared phrase; the
        # structured object and person checks still decide what counts as a match.
        subjects.append('a person')
    if requested['vehicle_colours']:
        subjects.append('a '+' and '.join(requested['vehicle_colours'])+' '+(kind or 'vehicle'))
    elif kind:
        subjects.append('a '+kind)
    if not subjects:
        return None
    relation=' near ' if re.search(r'靠近|附近|旁边|身边|\b(?:near|beside|dekat|berhampiran)\b',query.casefold()) else ' and '
    text=relation.join(subjects)
    others=[k for k in requested['objects'] if k not in {'person','vehicle','car','truck','bus','bicycle'}]
    return text+(' near '+' and '.join(others) if others else '')


def missing_attributes(text,attributes,requested):
    facts=attributes or {}
    if 'people' in facts and 'vehicles' in facts:
        people={p.get('clothing_color') for p in facts['people']}
        vehicles={v.get('color') for v in facts['vehicles']}
        objects={v.get('type') for v in facts['vehicles']}
        if facts['people']:
            objects.add('person')
        if facts['vehicles']:
            objects.add('vehicle')
        other=' '.join(str(o) for o in facts.get('objects',[])).casefold()
        for name,pattern in OBJECTS.items():
            if name not in {'person','vehicle','car','truck','bus','bicycle'} and re.search(pattern,other):
                objects.add(name)
    else:
        # Legacy indexes have no structured attributes. Accept only explicit phrases.
        inferred=constraints(text)
        people,vehicles=set(inferred['person_colours']),set(inferred['vehicle_colours'])
        objects=set(inferred['objects'])
        if objects&{'car','truck','bus','bicycle'}:
            objects.add('vehicle')
    missing=[]
    for value in requested['person_colours']:
        if value not in people:
            missing.append('person clothing: '+value)
    for value in requested['vehicle_colours']:
        if value not in vehicles:
            missing.append('vehicle colour: '+value)
    for value in requested['other_colours']:
        if value not in people|vehicles and not re.search(r'\b'+re.escape(value)+r'\b',text.casefold()):
            missing.append('colour: '+value)
    for value in requested['objects']:
        if value not in objects:
            missing.append('visible object: '+value)
    return missing
