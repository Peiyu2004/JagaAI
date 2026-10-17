import { get, put, now, transaction } from '../../../packages/shared/store.ts';
import { hashPassword, type User } from './auth.ts';

export const demoPassword = 'JagaLocal!2026';
export function seedDemo() {
  transaction(() => {
    const townshipId = 'township_serenia';
    const add = (kind: string, record: any) => { if (!get(kind, record.id)) put(kind, record); };
    add('townships', { id: townshipId, name: 'Serenia City · Synthetic demo', demo: true });
    add('townships', { id: 'township_other', name: 'Other township · Synthetic security fixture', demo: true });
    const users: Array<Omit<User, 'passwordHash'>> = [
      { id: 'user_manager', townshipId, name: 'Aisha · Demo manager', email: 'manager@jaga.local', role: 'management', membershipStatus: 'active', demo: true },
      { id: 'user_guard', townshipId, name: 'Daniel · Demo guard', email: 'guard@jaga.local', role: 'guard', membershipStatus: 'active', demo: true },
      { id: 'user_maintenance', townshipId, name: 'Ravi · Demo property team', email: 'maintenance@jaga.local', role: 'maintenance', membershipStatus: 'active', demo: true },
      { id: 'user_resident', townshipId, name: 'Mei · Demo resident', email: 'resident@jaga.local', role: 'resident', membershipStatus: 'active', demo: true },
      { id: 'user_other', townshipId: 'township_other', name: 'Other township demo resident', email: 'other@jaga.local', role: 'resident', membershipStatus: 'active', demo: true },
    ];
    for (const user of users) if (!get('users', user.id)) put('users', { ...user, passwordHash: hashPassword(demoPassword) });
    for (const [id, name, zone] of [['loc_north', 'North Gate', 'North'], ['loc_lake', 'Lakeside Walk', 'Lakeside'], ['loc_club', 'Clubhouse', 'Central'], ['loc_block', 'Block A', 'Residential']]) {
      add('locations', { id, townshipId, name, zone, demo: true });
    }
    for (const [id, name, locationId] of [['cam_north', 'North Gate · Demo camera', 'loc_north'], ['cam_lake', 'Lakeside Walk · Demo camera', 'loc_lake'], ['cam_club', 'Clubhouse · Demo camera', 'loc_club']]) {
      add('cameras', { id, townshipId, name, locationId, sourceType: 'upload', demo: true });
    }
    add('locations', { id: 'loc_parking_b', townshipId, name: 'Zone B Parking', aliases: ['B区停车场', 'B 区停车场', 'B区', 'B 区', 'parking B'], zone: 'B', demo: true });
    add('cameras', { id: 'cam_parking_b', townshipId, name: 'Zone B Parking · Demo camera', locationId: 'loc_parking_b', sourceType: 'upload', demo: true });
    const createdAt = now();
    const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
    const future = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
    add('reports', { id: 'report_bicycle', townshipId, number: 'JG-DEMO-001', reporterId: 'user_resident', locationId: 'loc_club', category: 'property', timeFrom: ago(3), timeTo: ago(2), description: '[Synthetic demo] A bicycle was missing from the clubhouse rack. Please review the available evidence.', photoIds: [], status: 'submitted', publicUpdates: [], createdAt, demo: true });
    add('reports', { id: 'report_light', townshipId, number: 'JG-DEMO-002', reporterId: 'user_resident', locationId: 'loc_block', category: 'maintenance', timeFrom: ago(5), timeTo: ago(4), description: '[Synthetic demo] The walkway light near Block A is flickering.', photoIds: [], status: 'linked', incidentId: 'incident_light', publicUpdates: [{ status: 'assigned', note: 'A staff member has been assigned to check the light.', createdAt }], createdAt, demo: true });
    add('reports', { id: 'report_other', townshipId: 'township_other', number: 'JG-OTHER-001', reporterId: 'user_other', locationId: 'loc_other', category: 'maintenance', timeFrom: ago(2), timeTo: ago(1), description: '[Synthetic security fixture] Other township private report.', photoIds: [], status: 'submitted', publicUpdates: [], createdAt, demo: true });
    add('locations', { id: 'loc_other', townshipId: 'township_other', name: 'Other township gate', zone: 'Other', demo: true });
    add('incidents', { id: 'incident_light', townshipId, title: '[Demo] Inspect Block A walkway light', category: 'maintenance', locationId: 'loc_block', priority: 'normal', status: 'assigned', createdBy: 'user_manager', reportIds: ['report_light'], alertIds: [], createdAt, updatedAt: createdAt, demo: true });
    add('assignments', { id: 'assignment_light', townshipId, incidentId: 'incident_light', assigneeId: 'user_guard', status: 'assigned', createdAt, demo: true });
    add('incidentUpdates', { id: 'update_light', townshipId, incidentId: 'incident_light', authorId: 'user_manager', action: 'assign', note: 'A staff member has been assigned to check the light.', visibility: 'public', createdAt, demo: true });
    add('incidentUpdates', { id: 'update_light_internal', townshipId, incidentId: 'incident_light', authorId: 'user_manager', action: 'note', note: '[Synthetic demo internal note] Check the electrical cabinet with the maintenance team.', visibility: 'internal', createdAt, demo: true });
    add('activities', { id: 'activity_safety_past', townshipId, title: 'Safety training · Synthetic demo', type: 'training', locationId: 'loc_club', startAt: ago(4), endAt: ago(2), capacity: 20, points: 30, description: '[Synthetic demo] A completed safety workshop, ready for attendance verification.', status: 'published', createdBy: 'user_manager', createdAt, demo: true });
    add('activities', { id: 'activity_walk', townshipId, title: 'Facilities walk · Synthetic demo', type: 'inspection', locationId: 'loc_lake', startAt: future(48), endAt: future(50), capacity: 12, points: 20, description: '[Synthetic demo] An approved facilities walk with the community team.', status: 'published', createdBy: 'user_manager', createdAt, demo: true });
    add('activities', { id: 'activity_briefing', townshipId, title: 'Community safety briefing · Synthetic demo', type: 'briefing', locationId: 'loc_club', startAt: future(96), endAt: future(97), capacity: 30, points: 10, description: '[Synthetic demo] Meet the local safety coordinators.', status: 'published', createdBy: 'user_manager', createdAt, demo: true });
    add('registrations', { id: 'registration_safety_resident', townshipId, activityId: 'activity_safety_past', userId: 'user_resident', status: 'registered', createdAt, demo: true });
  });
}
