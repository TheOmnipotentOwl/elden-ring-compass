import { useDataTableData } from '@/lib/data-table-data';
import { eventsDbView } from '@/lib/vm/events';
import { useManualToggle } from '@/stores/manual-overrides-store';
import { commonAccessorColumnDef, commonPinColumnDef } from '../data-table/common-column-defs';
import { DataTable } from '../data-table/data-table';
import { createAppColumnHelper, DataTableColumnDef, DataTableRow } from '../data-table/table-hook';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Checkbox } from '../ui/checkbox';

type Grace = ReturnType<typeof eventsDbView>[0];

/** Manual-toggle checkbox for a single grace row. */
function ManualDiscoveredCell({ row }: { row: DataTableRow<Grace> }) {
  const { isManuallyDone, toggle } = useManualToggle(row.original.id.toString());
  return (
    <div className='flex justify-center'>
      <Checkbox
        checked={isManuallyDone}
        onCheckedChange={toggle}
        aria-label={`Manually mark ${row.original.name} as discovered`}
      />
    </div>
  );
}

export function GracesDataTable() {
  // `eventsDbView` carries graces + bosses (it feeds the map pins). Bosses have a
  // dedicated, richer route (/bosses), so this table is graces-only.
  const items = useDataTableData('events').filter((e) => e.type === 'grace');
  const litCount = items.filter((item) => item.on).length;

  return (
    <Card className='flex min-h-0 w-full flex-1 flex-col'>
      <CardHeader className='shrink-0'>
        <CardTitle>Sites of Grace</CardTitle>
        <CardDescription>
          Graces discovered across the Lands Between
          <br />
          {litCount} / {items.length} · {((litCount / items.length) * 100).toFixed(0)}% lit
          <br />
          Use the <strong>Manual</strong> column to mark graces as visited without a save file —
          your choices are saved in this browser.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex min-h-0 flex-1 flex-col'>
        {/* tableId stays 'events' so column state + map pin-selection sync are shared. */}
        <DataTable tableId='events' columns={columns} data={items} fill />
      </CardContent>
    </Card>
  );
}

const columnHelper = createAppColumnHelper<Grace>();
const columns: Array<DataTableColumnDef<Grace>> = [
  commonPinColumnDef(columnHelper),
  commonAccessorColumnDef(columnHelper, 'id', 'ID', { size: 1 }),
  commonAccessorColumnDef(columnHelper, 'name', 'Name', {
    filterFn: 'includesString',
  }),
  commonAccessorColumnDef(columnHelper, 'subtitle', 'Region', {
    filterFn: 'includesString',
  }),
  commonAccessorColumnDef(columnHelper, 'on', 'Discovered'),
  // Manual toggle — persisted to localStorage, works with or without a save file.
  columnHelper.display({
    id: 'manual',
    header: 'Manual',
    size: 72,
    enableSorting: false,
    enableHiding: true,
    enableResizing: false,
    enableColumnFilter: false,
    cell: ({ row }) => <ManualDiscoveredCell row={row} />,
  }),
  commonAccessorColumnDef(columnHelper, (row) => !!row.pixel, 'Has Coordinates'),
];
